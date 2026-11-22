import type { ProfileTemplate, ProfileTemplateId, ProfileWithUsage } from '../../src/shared/api-types.ts';
import type { ApiCall } from './server.ts';

/** The first-run flow over the API: pick a capability template and save it under a player name. */
export async function createTemplateProfile(call: ApiCall, id: ProfileTemplateId, name: string) {
  const templates = await call<ProfileTemplate[]>('/api/v1/profiles/templates');
  const template = templates.find((candidate) => candidate.id === id);
  if (!template) throw new Error(`no "${id}" template in ${JSON.stringify(templates.map((item) => item.id))}`);
  return call<ProfileWithUsage>('/api/v1/profiles', {
    method: 'POST',
    json: { name, definition: template.definition },
  });
}
