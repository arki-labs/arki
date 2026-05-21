CREATE SCHEMA "arki";
--> statement-breakpoint
CREATE TYPE "arki"."restricted_resources" AS ENUM('collection', 'user', 'annotation', 'poem', 'workshop', 'comment', 'system', 'poet', 'reaction', 'message', 'list', 'claim');--> statement-breakpoint
CREATE TYPE "arki"."user_permissions" AS ENUM('read', 'create', 'update', 'delete', 'reply', 'vote', 'admin', 'join', 'moderate');--> statement-breakpoint
CREATE TYPE "arki"."user_roles" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "arki"."entity_edit_status" AS ENUM('pending', 'applied', 'rejected');--> statement-breakpoint
CREATE TYPE "arki"."follow_status" AS ENUM('pending', 'approved', 'declined', 'cancelled', 'blocked');--> statement-breakpoint
CREATE TYPE "arki"."moderation_status" AS ENUM('pending-review', 'approved', 'rejected', 'blocked');--> statement-breakpoint
CREATE TYPE "arki"."moderator_permission_level" AS ENUM('full', 'edit_only', 'review_only');--> statement-breakpoint
CREATE TYPE "arki"."notification_preference" AS ENUM('all', 'none', 'poems-only', 'comments-and-likes', 'important-updates-only', 'custom');--> statement-breakpoint
CREATE TYPE "arki"."poem_format" AS ENUM('free_verse', 'sonnet', 'haiku', 'limerick', 'acrostic', 'ballad', 'villanelle', 'concrete', 'prose', 'slam', 'interactive', 'visual', 'multimedia', 'video', 'collaborative', 'generative');--> statement-breakpoint
CREATE TYPE "arki"."publication_status" AS ENUM('draft', 'pending-review', 'published', 'archived', 'rejected', 'scheduled', 'unpublished', 'deleted');--> statement-breakpoint
CREATE TYPE "arki"."reaction_type" AS ENUM('like', 'love', 'laugh', 'wow', 'sad', 'angry', 'clap', 'think', 'fire', 'star');--> statement-breakpoint
CREATE TYPE "arki"."report_reason" AS ENUM('inappropriate', 'infringement', 'hate', 'spam', 'harassment', 'false-info', 'off-topic', 'privacy', 'other');--> statement-breakpoint
CREATE TYPE "arki"."report_status" AS ENUM('pending', 'under-review', 'resolved', 'dismissed', 'escalated', 'closed');--> statement-breakpoint
CREATE TYPE "arki"."visibility_level" AS ENUM('public', 'private', 'friends-only', 'custom', 'unlisted');--> statement-breakpoint
CREATE TABLE "arki"."accounts" (
	"id" varchar(256) PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arki"."permissions" (
	"id" varchar(256) PRIMARY KEY,
	"name" varchar(100) NOT NULL UNIQUE,
	"description" text,
	"resource" "arki"."restricted_resources" NOT NULL,
	"action" "arki"."user_permissions" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arki"."roles" (
	"id" varchar(256) PRIMARY KEY,
	"name" varchar(100) NOT NULL UNIQUE,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arki"."role_permissions" (
	"role_id" varchar,
	"permission_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_pkey" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "arki"."sessions" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arki"."users" (
	"id" varchar(256) PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean NOT NULL,
	"image" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"tweaks" jsonb DEFAULT '{"version":1,"global":{},"pageScoped":{}}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arki"."user_role_assignments" (
	"user_id" varchar,
	"role_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_role_assignments_pkey" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "arki"."verifications" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "arki"."accounts" ADD CONSTRAINT "accounts_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "arki"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "arki"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "arki"."roles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "arki"."role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "arki"."permissions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "arki"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "arki"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "arki"."user_role_assignments" ADD CONSTRAINT "user_role_assignments_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "arki"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "arki"."user_role_assignments" ADD CONSTRAINT "user_role_assignments_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "arki"."roles"("id") ON DELETE CASCADE;