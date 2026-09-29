export function policy() {
  return {
    schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe',
    selections: [{
      id: 'guidance', managementId: 'team-guidance', scope: 'project',
      configuration: { text: "Read the project's contribution guide.\n" }, requires: [],
      recipe: { inline: {
        schema: 'urn:aihq:core:recipe:1.0.0', id: 'guidance-file',
        description: 'Deliver project guidance',
        inputs: { text: { type: 'string', required: true, maxLength: 65536 } },
        materials: [], targets: ['project'], prerequisites: [],
        operations: [{
          id: 'write', purpose: 'Write shared project guidance', kind: 'file.write',
          scope: 'project', target: { root: 'project', segments: [{ literal: 'TEAM.md' }] },
          content: { input: 'text' }, requires: [], checks: []
        }], checks: []
      }}
    }]
  };
}
