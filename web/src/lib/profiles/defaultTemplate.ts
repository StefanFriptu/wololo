import type { ProfileTemplate } from '#lib/shared.ts';

const DEFAULT_TEMPLATE_ID = 'dolby';

export function defaultTemplate(templates: readonly ProfileTemplate[]): ProfileTemplate | undefined {
  return templates.find((template) => template.id === DEFAULT_TEMPLATE_ID) ?? templates[0];
}
