import { ORPCError } from '@orpc/server';

import { permissionProcedure, protectedProcedure } from '../../../core/orpc';
import { updateProfileSchema } from './types';

export const profileRouter = {
  updateProfile: permissionProcedure('user', 'update')
    .input(updateProfileSchema)
    .handler(async ({ context, input }) => {
      const userId = context.user.id;
      const userRepository = context.repo.auth;

      const updatedUser = await userRepository.update(userId, {
        ...input,
      });

      return {
        user: updatedUser,
      };
    }),

  getProfile: protectedProcedure.handler(async ({ context }) => {
    const userId = context.user.id;
    const userRepository = context.repo.auth;

    const user = await userRepository.findById(userId);
    if (!user) {
      throw new ORPCError('NOT_FOUND', {
        message: 'User not found',
      });
    }

    return {
      user,
    };
  }),
};
