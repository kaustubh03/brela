-- ============================================================================
-- Migration 001: Initial schema
-- ============================================================================
-- This is the same as schema.sql — the first migration bootstraps everything.
-- For subsequent changes, create 002_xxx.sql, 003_xxx.sql, etc.
-- ============================================================================

-- See ../schema.sql for the full DDL.
-- In a production workflow you would use `supabase db diff` to generate
-- migration files automatically. This file exists as a placeholder to
-- establish the migration directory convention.

\i ../schema.sql
