// ── Weekly digest generator ───────────────────────────────────────────────────
// Reads pending email_digests records, generates digest data from
// usage_summaries, renders HTML, and sends via SMTP.

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { getServiceClient } from '../../db/client.js';
import { config } from '../../config.js';
import { weeklyDigestHtml, weeklyDigestSubject, type DigestData } from './templates.js';
import type {
  EmailDigestRow,
  ProfileRow,
  ProjectRow,
  UsageSummaryRow,
} from '../../db/types.js';

let _transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth:
        config.smtp.user && config.smtp.pass
          ? { user: config.smtp.user, pass: config.smtp.pass }
          : undefined,
    });
  }
  return _transporter;
}

/**
 * Process all pending weekly digest emails.
 * This is designed to be called from a pg_cron trigger or a manual API endpoint.
 */
export async function processWeeklyDigests(): Promise<{ sent: number; failed: number }> {
  const supabase = getServiceClient();
  let sent = 0;
  let failed = 0;

  // Fetch all pending weekly digests
  const { data: pendingDigests, error: fetchError } = await supabase
    .from('email_digests')
    .select('id, user_id, project_id')
    .eq('digest_type', 'weekly')
    .eq('status', 'pending')
    .limit(100);

  if (fetchError || !pendingDigests || pendingDigests.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const digests = pendingDigests as Pick<EmailDigestRow, 'id' | 'user_id' | 'project_id'>[];

  for (const digest of digests) {
    try {
      // Fetch user profile
      const { data: profileData } = await supabase
        .from('profiles')
        .select('email, full_name')
        .eq('id', digest.user_id)
        .single();

      const profile = profileData as Pick<ProfileRow, 'email' | 'full_name'> | null;

      if (!profile?.email) {
        await markDigestFailed(digest.id);
        failed++;
        continue;
      }

      // Fetch project
      const { data: projectData } = await supabase
        .from('projects')
        .select('name')
        .eq('id', digest.project_id)
        .single();

      const project = projectData as Pick<ProjectRow, 'name'> | null;

      if (!project) {
        await markDigestFailed(digest.id);
        failed++;
        continue;
      }

      // Fetch last 7 days of usage summaries
      const now = new Date();
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const twoWeeksAgo = new Date(now);
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

      const toDate = now.toISOString().slice(0, 10);
      const fromDate = weekAgo.toISOString().slice(0, 10);
      const prevFromDate = twoWeeksAgo.toISOString().slice(0, 10);

      const { data: currentUsageData } = await supabase
        .from('usage_summaries')
        .select('tool, total_lines, total_chars, event_count')
        .eq('project_id', digest.project_id)
        .gte('date', fromDate)
        .lte('date', toDate);

      const { data: prevUsageData } = await supabase
        .from('usage_summaries')
        .select('total_lines')
        .eq('project_id', digest.project_id)
        .gte('date', prevFromDate)
        .lt('date', fromDate);

      const currentUsage = (currentUsageData ?? []) as Pick<UsageSummaryRow, 'tool' | 'total_lines' | 'total_chars' | 'event_count'>[];
      const prevUsage = (prevUsageData ?? []) as Pick<UsageSummaryRow, 'total_lines'>[];

      // Aggregate current week
      const toolMap = new Map<string, number>();
      let totalAiLines = 0;
      for (const row of currentUsage) {
        totalAiLines += row.total_lines;
        toolMap.set(row.tool, (toolMap.get(row.tool) ?? 0) + row.total_lines);
      }

      // Previous week total for trend
      const prevTotal = prevUsage.reduce((sum: number, r) => sum + r.total_lines, 0);

      // Trend calculation
      let trendDirection: DigestData['trendDirection'] = 'stable';
      let trendDelta = 0;
      if (prevTotal > 0) {
        trendDelta = ((totalAiLines - prevTotal) / prevTotal) * 100;
        trendDirection = trendDelta > 2 ? 'up' : trendDelta < -2 ? 'down' : 'stable';
      }

      const topTools = [...toolMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, lines]) => ({
          name,
          percentage: totalAiLines > 0 ? (lines / totalAiLines) * 100 : 0,
        }));

      // Estimate human lines (rough: assume ~2x ratio if no data)
      const totalHumanLines = Math.max(0, Math.round(totalAiLines * 1.5));

      const digestData: DigestData = {
        userName: profile.full_name ?? profile.email.split('@')[0] ?? 'there',
        projectName: project.name,
        dateFrom: fromDate,
        dateTo: toDate,
        aiPercentage: totalAiLines > 0 ? (totalAiLines / (totalAiLines + totalHumanLines)) * 100 : 0,
        totalAiLines,
        totalHumanLines,
        topTools,
        trendDirection,
        trendDelta: Math.abs(trendDelta),
        reportUrl: `${config.appUrl}/projects/${digest.project_id}/reports`,
      };

      const html = weeklyDigestHtml(digestData);
      const subject = weeklyDigestSubject(project.name, `${fromDate} – ${toDate}`);

      // Send email
      if (config.smtp.host) {
        await getTransporter().sendMail({
          from: config.smtp.from,
          to: profile.email,
          subject,
          html,
        });
      }

      // Mark as sent
      await supabase
        .from('email_digests')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          report_snapshot: digestData as unknown as Record<string, unknown>,
        })
        .eq('id', digest.id);

      sent++;
    } catch {
      await markDigestFailed(digest.id);
      failed++;
    }
  }

  return { sent, failed };
}

async function markDigestFailed(digestId: string): Promise<void> {
  const supabase = getServiceClient();
  await supabase
    .from('email_digests')
    .update({ status: 'failed' })
    .eq('id', digestId);
}
