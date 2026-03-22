// ── Email HTML templates ─────────────────────────────────────────────────────
// Server-rendered HTML email templates for weekly digest emails.

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(n: number): string {
  return n.toFixed(1) + '%';
}

export interface DigestData {
  userName: string;
  projectName: string;
  dateFrom: string;
  dateTo: string;
  aiPercentage: number;
  totalAiLines: number;
  totalHumanLines: number;
  topTools: Array<{ name: string; percentage: number }>;
  trendDirection: 'up' | 'down' | 'stable';
  trendDelta: number;
  reportUrl: string;
}

export function weeklyDigestHtml(data: DigestData): string {
  const toolRows = data.topTools
    .slice(0, 5)
    .map(
      (t) => `
      <tr>
        <td style="padding:8px 16px;font-size:14px;color:#111827;border-bottom:1px solid #F3F4F6">${escHtml(t.name)}</td>
        <td style="padding:8px 16px;font-size:14px;color:#6B7280;text-align:right;border-bottom:1px solid #F3F4F6">${pct(t.percentage)}</td>
      </tr>`,
    )
    .join('\n');

  const trendIcon =
    data.trendDirection === 'up' ? '📈' : data.trendDirection === 'down' ? '📉' : '➡️';
  const trendLabel =
    data.trendDirection === 'up'
      ? `+${pct(data.trendDelta)} from last week`
      : data.trendDirection === 'down'
        ? `${pct(data.trendDelta)} from last week`
        : 'No change from last week';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brela Weekly Digest — ${escHtml(data.projectName)}</title>
</head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB">
<tr><td align="center" style="padding:32px 16px">

  <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">

    <!-- Header -->
    <tr>
      <td style="background:linear-gradient(135deg,#1F8EFA,#6366F1);padding:32px 40px">
        <table width="100%"><tr>
          <td style="font-size:20px;font-weight:700;color:#fff">👻 Brela Weekly Digest</td>
          <td style="text-align:right;font-size:13px;color:rgba(255,255,255,.8)">${escHtml(data.dateFrom)} – ${escHtml(data.dateTo)}</td>
        </tr></table>
      </td>
    </tr>

    <!-- Greeting -->
    <tr>
      <td style="padding:32px 40px 0">
        <p style="margin:0;font-size:16px;color:#111827">Hi ${escHtml(data.userName)},</p>
        <p style="margin:8px 0 0;font-size:14px;color:#6B7280;line-height:1.6">
          Here's your weekly AI code attribution summary for <strong>${escHtml(data.projectName)}</strong>.
        </p>
      </td>
    </tr>

    <!-- Stats grid -->
    <tr>
      <td style="padding:24px 40px">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="33%" style="background:#F0F9FF;border-radius:8px;padding:20px;text-align:center">
              <div style="font-size:28px;font-weight:700;color:#1F8EFA">${pct(data.aiPercentage)}</div>
              <div style="font-size:11px;color:#6B7280;text-transform:uppercase;letter-spacing:.05em;margin-top:4px">AI Code</div>
            </td>
            <td width="4%"></td>
            <td width="30%" style="background:#F9FAFB;border-radius:8px;padding:20px;text-align:center">
              <div style="font-size:24px;font-weight:700;color:#111827">${data.totalAiLines.toLocaleString()}</div>
              <div style="font-size:11px;color:#6B7280;text-transform:uppercase;letter-spacing:.05em;margin-top:4px">AI Lines</div>
            </td>
            <td width="4%"></td>
            <td width="30%" style="background:#F9FAFB;border-radius:8px;padding:20px;text-align:center">
              <div style="font-size:24px;font-weight:700;color:#111827">${data.totalHumanLines.toLocaleString()}</div>
              <div style="font-size:11px;color:#6B7280;text-transform:uppercase;letter-spacing:.05em;margin-top:4px">Human Lines</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Trend -->
    <tr>
      <td style="padding:0 40px 24px">
        <div style="background:#FFFBEB;border-radius:8px;padding:12px 16px;font-size:13px;color:#92400E">
          ${trendIcon} &nbsp; ${trendLabel}
        </div>
      </td>
    </tr>

    <!-- Top tools -->
    <tr>
      <td style="padding:0 40px 24px">
        <div style="font-size:13px;font-weight:600;color:#111827;margin-bottom:12px">Top AI Tools</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E7EB;border-radius:8px;overflow:hidden">
          <thead>
            <tr style="background:#F9FAFB">
              <th style="padding:8px 16px;text-align:left;font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;border-bottom:1px solid #E5E7EB">Tool</th>
              <th style="padding:8px 16px;text-align:right;font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;border-bottom:1px solid #E5E7EB">Share</th>
            </tr>
          </thead>
          <tbody>
            ${toolRows}
          </tbody>
        </table>
      </td>
    </tr>

    <!-- CTA -->
    <tr>
      <td style="padding:0 40px 32px;text-align:center">
        <a href="${escHtml(data.reportUrl)}"
           style="display:inline-block;padding:12px 32px;background:#1F8EFA;color:#fff;
                  font-size:14px;font-weight:600;text-decoration:none;border-radius:8px">
          View Full Report →
        </a>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="padding:20px 40px;background:#F9FAFB;border-top:1px solid #E5E7EB">
        <p style="margin:0;font-size:12px;color:#9CA3AF;text-align:center">
          Brela — Silent AI code attribution<br>
          <a href="${escHtml(data.reportUrl)}" style="color:#9CA3AF">Manage preferences</a>
        </p>
      </td>
    </tr>

  </table>

</td></tr>
</table>

</body>
</html>`;
}

export function weeklyDigestSubject(projectName: string, dateRange: string): string {
  return `Brela Weekly: ${projectName} — ${dateRange}`;
}
