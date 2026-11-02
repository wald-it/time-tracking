import type { Migration } from './index'

export const migration035: Migration = {
  version: 35,
  name: 'project-budget-types',
  up: `
    ALTER TABLE projects ADD COLUMN budget_kind TEXT NOT NULL DEFAULT 'hours'
      CHECK (budget_kind IN ('hours', 'eur'));
    ALTER TABLE projects ADD COLUMN budget_period TEXT NOT NULL DEFAULT 'total'
      CHECK (budget_period IN ('total', 'month'));
    ALTER TABLE projects ADD COLUMN budget_cent INTEGER NULL;
  `
}
