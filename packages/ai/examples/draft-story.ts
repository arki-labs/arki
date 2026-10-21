import { createFlow } from '../src/index.js';

// #region draft-story
type StoryState = { outline?: string; draft?: string };

type StoryContext = {
  /** Calls a model. A test passes a plain function instead. */
  write: (instruction: string) => Promise<string>;
};

/** Two steps in memory: outline, then draft. A restart loses a run that is in flight. */
const draftStory = createFlow<StoryState, StoryContext>({
  start: 'outline',
  nodes: {
    outline: {
      id: 'outline',
      run: async (_state, context) => ({ outline: await context.write('Outline a short story.') }),
      next: 'draft',
    },
    draft: {
      id: 'draft',
      run: async (state, context) => ({ draft: await context.write(`Write it from: ${state.outline ?? ''}`) }),
      next: undefined,
    },
  },
});
// #endregion draft-story

export { draftStory };
export type { StoryContext, StoryState };
