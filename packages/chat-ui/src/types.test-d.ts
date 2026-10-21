/** Compile-time only (checked by `tsc`): the public types keep their shape. */
import type { ComponentProps } from 'react';
import { expectTypeOf } from 'vitest';

import type { ApprovalCard } from './approval-card';
import type { StepIndicator } from './step-indicator';
import type { ToolComponent } from './tool-registry';
import type { AgentStatusType, AgentStep, ApprovalAction, ApprovalResult, ToolCallMeta, ToolCallStatus } from './types';
import { runtimeStatusToAgentStatus } from './runtime-conversation';
import { createToolRegistry } from './tool-registry';

expectTypeOf<ToolCallStatus>().toEqualTypeOf<'pending' | 'running' | 'complete' | 'error'>();
expectTypeOf<AgentStatusType>().toEqualTypeOf<
  'idle' | 'thinking' | 'executing' | 'waiting-for-input' | 'complete' | 'error'
>();
expectTypeOf<ApprovalAction>().toEqualTypeOf<'approve' | 'reject' | 'edit'>();
expectTypeOf<ApprovalResult['action']>().toEqualTypeOf<ApprovalAction>();
expectTypeOf<AgentStep['status']>().toEqualTypeOf<'pending' | 'active' | 'complete' | 'error'>();
expectTypeOf<ToolCallMeta['status']>().toEqualTypeOf<ToolCallStatus>();

expectTypeOf(runtimeStatusToAgentStatus).returns.toEqualTypeOf<AgentStatusType>();
expectTypeOf(createToolRegistry).parameter(0).toEqualTypeOf<Record<string, ToolComponent>>();
expectTypeOf<ComponentProps<typeof ApprovalCard>['onAction']>().parameter(0).toEqualTypeOf<ApprovalResult>();
expectTypeOf<ComponentProps<typeof StepIndicator>['steps']>().toEqualTypeOf<AgentStep[]>();
