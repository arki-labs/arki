'use client';

import type { ComponentType } from 'react';

import { Link } from '@tanstack/react-router';

import { ArrowRight, Compass } from '@arki/icons/phosphor';
import { Badge } from '@arki/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arki/ui/card';
import { cn } from '@arki/ui/cn';

import { ItemListSchema } from './item-list-schema';

type RelatedItem = {
  key: string;
  title: string;
  description: string;
};

type RelatedItemsProps = {
  items: RelatedItem[];
  title?: string;
  description?: string;
  className?: string;
  /** Whether to include the ItemList schema for SEO */
  includeSchema?: boolean;
  /** Unique ID for the schema (e.g., 'related-to-gradient') */
  schemaId?: string;
  /** Label for each item type (e.g., 'tool', 'calculator'). Used in CTAs. */
  itemLabel?: string;
  /** Builds the href for each item. Defaults to `(key) => \`/\${key}\`` */
  hrefBuilder?: (key: string) => string;
  /** Icon component for each item card */
  icon?: ComponentType<{ className?: string }>;
  /** Site URL for schema generation */
  siteUrl: string;
};

function SectionHeader({
  title,
  description,
  count,
  itemLabel,
}: {
  title: string;
  description: string;
  count: number;
  itemLabel: string;
}) {
  return (
    <div className="mb-8">
      <div className="flex items-start gap-4">
        <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/80 to-primary shadow-lg shadow-primary/25">
          <Compass className="h-7 w-7 text-primary-foreground" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h2 className="font-serif text-2xl font-bold tracking-tight text-foreground">
              {title}
            </h2>
            <Badge variant="secondary" className="bg-primary/10 text-primary">
              {count} {itemLabel}{count === 1 ? '' : 's'}
            </Badge>
          </div>
          <p className="mt-2 max-w-2xl text-base text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
    </div>
  );
}

function ItemCard({
  item,
  itemLabel,
  hrefBuilder,
  Icon,
}: {
  item: RelatedItem;
  itemLabel: string;
  hrefBuilder: (key: string) => string;
  Icon: ComponentType<{ className?: string }>;
}) {
  return (
    <Link to={hrefBuilder(item.key) as string} className="group block h-full">
      <Card
        className={cn(
          'relative flex h-full flex-col overflow-hidden transition-all duration-300',
          'border border-border bg-card',
          'hover:-translate-y-1 hover:shadow-xl',
          'hover:border-primary/50',
          'hover:shadow-primary/10',
        )}
      >
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-primary/10 to-primary/5 opacity-0 transition-opacity duration-500 group-hover:opacity-100" />

        <CardHeader className="relative flex-shrink-0 pb-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary/10 transition-all duration-300 group-hover:scale-110 group-hover:bg-primary/20">
              <Icon className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <CardTitle className="line-clamp-2 text-base font-semibold leading-snug transition-colors duration-300 group-hover:text-primary">
                {item.title}
              </CardTitle>
            </div>
            <ArrowRight className="h-4 w-4 flex-shrink-0 text-muted-foreground transition-all duration-300 group-hover:translate-x-1 group-hover:text-primary" />
          </div>
        </CardHeader>

        <CardContent className="relative flex flex-1 flex-col pt-0">
          <CardDescription className="line-clamp-3 flex-1 text-sm leading-relaxed">
            {item.description}
          </CardDescription>

          <div className="mt-4 flex items-center text-sm font-medium text-primary">
            <span>Try this {itemLabel}</span>
            <ArrowRight className="ml-1.5 h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-1" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * Related items section for internal linking and SEO.
 * Displays a grid of related items with optional schema.org markup.
 * Generalized from domain-specific patterns to work across any app.
 */
export function RelatedItems({
  items,
  title = 'Related Items',
  description = 'Explore more items that might be useful for you',
  className,
  includeSchema = true,
  schemaId = 'related-items',
  itemLabel = 'item',
  hrefBuilder = (key) => `/${key}`,
  icon: Icon = ArrowRight,
  siteUrl,
}: RelatedItemsProps) {
  if (items.length === 0) return null;

  const schemaItems = items.map(item => ({
    name: item.title,
    url: hrefBuilder(item.key),
    description: item.description,
  }));

  return (
    <section className={cn('border-t border-border bg-muted/50 px-4 py-12 sm:px-6 lg:px-8', className)}>
      {includeSchema && (
        <ItemListSchema name={title} description={description} items={schemaItems} id={schemaId} siteUrl={siteUrl} />
      )}

      <SectionHeader title={title} description={description} count={items.length} itemLabel={itemLabel} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(item => (
          <ItemCard key={item.key} item={item} itemLabel={itemLabel} hrefBuilder={hrefBuilder} Icon={Icon} />
        ))}
      </div>
    </section>
  );
}

/**
 * Compact inline list of related items for sidebar or footer.
 */
export function RelatedItemsCompact({
  items,
  title = 'Related',
  className,
  hrefBuilder = (key) => `/${key}`,
  icon: Icon = ArrowRight,
}: {
  items: RelatedItem[];
  title?: string;
  className?: string;
  hrefBuilder?: (key: string) => string;
  icon?: ComponentType<{ className?: string }>;
}) {
  if (items.length === 0) return null;

  return (
    <div className={cn('', className)}>
      {title && <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>}

      <ul className="space-y-2">
        {items.map(item => (
          <li key={item.key}>
            <Link
              to={hrefBuilder(item.key) as string}
              className="group flex items-center gap-2 text-foreground transition-colors hover:text-primary"
            >
              <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground group-hover:text-primary" />
              <span className="truncate text-sm">{item.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
