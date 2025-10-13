import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { HonoAdapter } from '@bull-board/hono';
import type { Queue } from 'bullmq';
import type { MiddlewareHandler } from 'hono';

/**
 * Create a Bull Board UI for monitoring queues
 *
 * @example With Hono
 * ```typescript
 * import { Hono } from 'hono';
 * import { createBoard } from '@arki/queue';
 *
 * const app = new Hono();
 *
 * // Create board with all your queues
 * const { adapter } = createBoard({
 *   queues: [sendEmail._queue, processOrder._queue],
 *   basePath: '/admin/queues',
 * });
 *
 * // Mount the board
 * app.route('/admin/queues', adapter.registerPlugin());
 *
 * export default app;
 * ```
 *
 * @example Direct Board Access
 * ```typescript
 * const { board, adapter } = createBoard({
 *   queues: [myQueue._queue],
 * });
 *
 * // Add queues dynamically
 * board.addQueue(new BullMQAdapter(anotherQueue));
 *
 * // Remove queues
 * board.removeQueue('queue-name');
 * ```
 */
export function createBoard(options: {
  /**
   * Array of BullMQ Queue instances to monitor
   */
  queues: (Queue | undefined)[];

  /**
   * Base path for the UI (default: '/admin/queues')
   */
  basePath?: string;

  /**
   * Custom UI options
   */
  uiOptions?: {
    /**
     * Board title (default: 'Bull Board')
     */
    boardTitle?: string;

    /**
     * Custom logo URL
     */
    boardLogo?: string;

    /**
     * Misc UI options
     */
    miscLinks?: { text: string; url: string }[];
  };
}) {
  const { queues, basePath = '/admin/queues', uiOptions } = options;

  // Filter out undefined queues and create adapters
  const queueAdapters = queues.filter((q): q is Queue => q !== undefined).map(queue => new BullMQAdapter(queue));

  // Create Hono adapter
  const staticMiddlewareFactory = (): MiddlewareHandler => {
    return async (_c, next) => await next();
  };
  const serverAdapter = new HonoAdapter(staticMiddlewareFactory);
  serverAdapter.setBasePath(basePath);

  // Create the board
  const board = createBullBoard({
    queues: queueAdapters,
    serverAdapter,
    options: {
      uiConfig: {
        boardTitle: uiOptions?.boardTitle,
        boardLogo: uiOptions?.boardLogo ? { path: uiOptions.boardLogo } : undefined,
        miscLinks: uiOptions?.miscLinks,
      },
    },
  });

  return {
    /**
     * The Bull Board instance
     */
    board,

    /**
     * The Hono adapter (use with app.route())
     */
    adapter: serverAdapter,

    /**
     * Add a queue to the board dynamically
     */
    addQueue: (queue: Queue) => {
      board.addQueue(new BullMQAdapter(queue));
    },

    /**
     * Remove a queue from the board
     */
    removeQueue: (queueName: string) => {
      board.removeQueue(queueName);
    },
  };
}

/**
 * Create Bull Board adapters for different frameworks
 */


export { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
export { HonoAdapter } from '@bull-board/hono';
