import type {
  entityEditStatusEnum,
  followStatusEnum,
  moderationStatusEnum,
  moderatorPermissionLevelEnum,
  notificationPreferencesEnum,
  poemFormatEnum,
  publicationStatusEnum,
  reactionType,
  reportReasonEnum,
  reportStatusEnum,
  visibilityLevelsEnum,
} from './enum';

export type PoemFormat = (typeof poemFormatEnum.enumValues)[number];
export type PublicationStatus = (typeof publicationStatusEnum.enumValues)[number];
export type ReactionType = (typeof reactionType.enumValues)[number];
export type ReportReason = (typeof reportReasonEnum.enumValues)[number];
export type ReportStatus = (typeof reportStatusEnum.enumValues)[number];
export type FollowStatus = (typeof followStatusEnum.enumValues)[number];
export type NotificationPreference = (typeof notificationPreferencesEnum.enumValues)[number];
export type VisibilityLevel = (typeof visibilityLevelsEnum.enumValues)[number];
export type ModerationStatus = (typeof moderationStatusEnum.enumValues)[number];
export type EntityEditStatus = (typeof entityEditStatusEnum.enumValues)[number];
export type ModeratorPermissionLevel = (typeof moderatorPermissionLevelEnum.enumValues)[number];
