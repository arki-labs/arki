import { schema } from './_schema';

/**
 * Visibility levels for poems
 *
 * - Public: Visible to everyone
 * - Private: Visible only to the poet
 * - Friends-only: Visible to followers or friends of the poet
 * - Custom: Custom visibility settings
 * - Unlisted: Not listed publicly but accessible via direct link
 */
export const visibilityLevelsEnum = schema.enum('visibility_level', [
  'public',
  'private',
  'friends-only',
  'custom',
  'unlisted',
]);

/**
 * Publication status for poems
 *
 * - Draft: In progress
 * - Pending-review: Submitted for review
 * - Published: Fully published
 * - Archived: No longer actively displayed
 * - Rejected: Not approved for publication
 * - Scheduled: Set to be published at a future date
 */
export const publicationStatusEnum = schema.enum('publication_status', [
  'draft',
  'pending-review',
  'published',
  'archived',
  'rejected',
  'scheduled',
  'unpublished',
  'deleted',
]);

export const reactionType = schema.enum('reaction_type', [
  'like',
  'love',
  'laugh',
  'wow',
  'sad',
  'angry',
  'clap',
  'think',
  'fire',
  'star',
]);

/**
 * Report reasons for content
 *
 * - Inappropriate: Offensive or explicit material
 * - Infringement: Copyright violation
 * - Hate: Hate speech or discrimination
 * - Spam: Spam or unwanted advertising
 * - Harassment: Harassment or bullying
 * - False-info: Misinformation
 * - Off-topic: Irrelevant content
 * - Privacy: Privacy violation
 * - Other: Other reasons
 */
export const reportReasonEnum = schema.enum('report_reason', [
  'inappropriate',
  'infringement',
  'hate',
  'spam',
  'harassment',
  'false-info',
  'off-topic',
  'privacy',
  'other',
]);

/**
 * Report status
 *
 * - Pending: New report, not yet reviewed
 * - Under-review: Being examined by moderators
 * - Resolved: Issue addressed and action taken
 * - Dismissed: Report deemed unfounded
 * - Escalated: Serious report escalated to higher authorities
 * - Closed: Fully processed, no further action needed
 */
export const reportStatusEnum = schema.enum('report_status', [
  'pending',
  'under-review',
  'resolved',
  'dismissed',
  'escalated',
  'closed',
]);

/**
 * Follow status
 *
 * - Pending: Request sent but not responded to
 * - Approved: Request accepted
 * - Declined: Request rejected
 * - Cancelled: Request withdrawn by requester
 * - Blocked: Request blocked by recipient
 */
export const followStatusEnum = schema.enum('follow_status', [
  'pending',
  'approved',
  'declined',
  'cancelled',
  'blocked',
]);

/**
 * Notification preferences
 *
 * - All: Receive all notifications
 * - None: Opt out of all notifications
 * - Poems-only: Notifications for new poems only
 * - Comments-and-likes: Notifications for interactions only
 * - Important-updates-only: Only critical announcements
 * - Custom: Custom notification settings
 */
export const notificationPreferencesEnum = schema.enum('notification_preference', [
  'all',
  'none',
  'poems-only',
  'comments-and-likes',
  'important-updates-only',
  'custom',
]);

/**
 * Common Poetry Formats
Free Verse - Poetry without regular meter or rhyme schemes
Sonnet - 14-line poem with specific rhyme schemes (Petrarchan, Shakespearean)
Haiku - 3-line poem with 5-7-5 syllable pattern
Limerick - 5-line humorous poem with AABBA rhyme scheme
Acrostic - Poem where first letters of each line spell a word
Ballad - Narrative poem, often with repeated refrains
Villanelle - 19-line poem with repeated lines and specific rhyme pattern
Concrete/Visual - Poem whose visual arrangement contributes to meaning
Prose Poetry - Poetry written in prose form without line breaks
Slam - Performance-oriented poetry
Modern Digital Formats
Interactive - Poems with reader interaction elements
Visual - Poems with integrated visual elements/imagery
Multimedia - Combining text with other media forms
Video Poetry - Poetry designed for video presentation
Collaborative - Co-created with multiple authors
Generative - Created with AI or algorithmic assistance
 */
export const poemFormatEnum = schema.enum('poem_format', [
  'free_verse',
  'sonnet',
  'haiku',
  'limerick',
  'acrostic',
  'ballad',
  'villanelle',
  'concrete',
  'prose',
  'slam',
  'interactive',
  'visual',
  'multimedia',
  'video',
  'collaborative',
  'generative',
]);

/**
 * Moderation status
 *
 * - Pending-review: Pending review by moderators
 * - Approved: Approved by moderators
 * - Rejected: Rejected by moderators
 */
export const moderationStatusEnum = schema.enum('moderation_status', [
  'pending-review',
  'approved',
  'rejected',
  'blocked',
]);

/**
 * Entity edit status
 *
 * - Pending: Pending review by moderators
 * - Approved: Approved by moderators
 * - Rejected: Rejected by moderators
 */
export const entityEditStatusEnum = schema.enum('entity_edit_status', ['pending', 'applied', 'rejected']);

/**
 * Moderator permission level
 *
 * - Full: Full access to entity profile
 * - Edit-only: Can suggest edits but not approve/reject
 * - Review-only: Can only approve/reject but not edit
 */
export const moderatorPermissionLevelEnum = schema.enum('moderator_permission_level', [
  'full',
  'edit_only',
  'review_only',
]);
