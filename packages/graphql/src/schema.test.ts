import { describe, expect, it } from 'vitest';
import { createSchema } from './schema';

describe('graphql schema', () => {
  it('builds with the assistant fields the resolvers implement', () => {
    const schema = createSchema();
    const query = schema.getQueryType()?.getFields();
    const mutation = schema.getMutationType()?.getFields();
    expect(query?.assistantSettings).toBeTruthy();
    expect(query?.assistantFollows).toBeTruthy();
    expect(mutation?.saveAssistantSettings).toBeTruthy();
    expect(mutation?.saveAssistantFollow).toBeTruthy();
    expect(mutation?.deleteAssistantFollow).toBeTruthy();
    expect(mutation?.deliverAssistantBrief).toBeTruthy();
    expect(query?.homeLayout).toBeTruthy();
    expect(query?.homeActivity).toBeTruthy();
    expect(query?.homeBrief).toBeTruthy();
    expect(query?.homeFollows).toBeTruthy();
    expect(mutation?.saveHomeLayout).toBeTruthy();
  });
});
