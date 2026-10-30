# Component reference

Every export of `@arki/ui`, grouped by what it is for. Each component is its own subpath: `import { Button } from '@arki/ui/button'`. There is no root import. Read the [agent guide](./agent-guide.md) first for the rules.

Most components are small wrappers over a Base UI primitive. They take the primitive's props and add classes. A name like `DialogTrigger` is a part of `Dialog`: use the parts together.

## Actions

- `buttonVariants`: the class recipe behind `Button`. Use it to style a link or other element like a button.
- `Toggle`, `toggleVariants`: a button that stays pressed. `toggleVariants` gives its classes.
- `ToggleGroup`, `ToggleGroupItem`: a set of toggles. Pick one or many.
- `Toolbar`: a bar of buttons and dividers.
- `ControlGroupItem`: one item inside a control group. It joins inputs and buttons into one bar with shared borders.

## Forms

- `Label`: the text label for a field.
- `Textarea`: a multi-line text field.
- `TextareaWithAutoSize`: a textarea that grows as the user types.
- `InputBase`: the shared frame for inputs that have icons or buttons inside. Its parts are `InputBaseAdornment` (an icon or text at the edge), `InputBaseAdornmentButton` (a button at the edge), `InputBaseControl` (wraps the real control), `InputBaseFlexWrapper` (lays out a control that wraps, like tags) and `InputBaseInput` (the text input inside the frame).
- `InputOTP`: a one-time code field. Parts: `InputOTPGroup` groups slots, `InputOTPSlot` is one digit, `InputOTPSeparator` is the dash between groups.
- `RadioGroup`, `RadioGroupItem`: choose one option from a list.
- `Switch`: an on and off toggle.
- `Slider`: pick a value or a range by dragging.
- `Select` parts: `SelectTrigger` (the closed box), `SelectValue` (the chosen value), `SelectContent` (the open list), `SelectItem` (one option), `SelectGroup` and `SelectLabel` (a titled group), `SelectSeparator` (a divider), `SelectScrollUpButton` and `SelectScrollDownButton` (scroll arrows for long lists).
- `DatePicker`: an input that opens a `Calendar`.
- `Calendar`: a month grid where the user picks days.
- `ColorPicker`: choose a colour from a panel or a hex field.
- `MathInput`: a field for typing maths with a keypad. `ComplexInput` is the same for complex numbers.
- `BlockMath`, `InlineMath`: render a LaTeX string with KaTeX, on its own line or inside text.

### Form fields (React Hook Form)

- `FormControl`: wraps the input so it gets the field's id and error state.
- `FormItem`: one field row. Groups label, control, hints and message.
- `FormLabel`: the label, wired to the field and marked red on error.
- `FormDescription`: grey help text under the control.
- `FormMessage`: the error text for the field.
- `FormHints`: small clickable suggestions. A click sets the field to that value.
- `useForm`, `useWatch`, `zodResolver`: re-exported from React Hook Form and its Zod resolver, so you import form tools from one place.

## Overlays

- `Dialog` parts: `DialogClose` (a close button), `DialogFooter` (the action row), `DialogOverlay` (the dark backdrop), `DialogPortal` (renders outside the page tree).
- `AlertDialog`: a modal that asks the user to confirm before an action. Parts: `AlertDialogTrigger`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogAction` (confirm), `AlertDialogCancel` (back out), `AlertDialogOverlay`, `AlertDialogPortal`.
- `Drawer`: a panel that slides in from an edge, with drag to close. Parts: `DrawerTrigger`, `DrawerContent`, `DrawerHeader`, `DrawerTitle`, `DrawerDescription`, `DrawerFooter`, `DrawerClose`, `DrawerOverlay`, `DrawerPortal`.
- `Sheet`: a side panel that slides in from a screen edge. Parts: `SheetTrigger`, `SheetContent`, `SheetHeader`, `SheetTitle`, `SheetDescription`, `SheetFooter`, `SheetClose`.
- `Popover`: a floating panel anchored to a button. Parts: `PopoverTrigger`, `PopoverContent`, `PopoverClose`.
- `HoverCard`: a preview card that opens on hover. Parts: `HoverCardTrigger`, `HoverCardContent`.
- `Tooltip`: a short hint on hover or focus. Parts: `TooltipProvider` (mount once), `TooltipTrigger`, `TooltipContent`. `WithTooltip` is the short form: wrap an element and pass the tip text.
- `Command`: a searchable list of actions. Parts: `CommandInput`, `CommandList`, `CommandEmpty` (no results), `CommandGroup`, `CommandItem`, `CommandSeparator`, `CommandShortcut` (key hint). `CommandDialog` puts it in a modal, like a command palette.

## Menus and navigation

- `DropdownMenu`: a menu that opens from a button. Parts: `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuCheckboxItem`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuGroup`, `DropdownMenuGroupLabel` and `DropdownMenuLabel` (headings), `DropdownMenuSeparator`, `DropdownMenuShortcut`, `DropdownMenuSub`, `DropdownMenuSubTrigger`, `DropdownMenuSubContent`, `DropdownMenuPortal`.
- `ContextMenu`: the same menu shape, opened by right click. Parts: `ContextMenuTrigger`, `ContextMenuContent`, `ContextMenuItem`, `ContextMenuCheckboxItem`, `ContextMenuRadioGroup`, `ContextMenuRadioItem`, `ContextMenuGroup`, `ContextMenuLabel`, `ContextMenuSeparator`, `ContextMenuShortcut`, `ContextMenuSub`, `ContextMenuSubTrigger`, `ContextMenuSubContent`, `ContextMenuPortal`.
- `Menubar`: a row of menus, like an app menu bar. Parts: `MenubarMenu` (one top menu), `MenubarTrigger`, `MenubarContent`, `MenubarItem`, `MenubarCheckboxItem`, `MenubarRadioGroup`, `MenubarRadioItem`, `MenubarGroup`, `MenubarLabel`, `MenubarSeparator`, `MenubarShortcut`, `MenubarSub`, `MenubarSubTrigger`, `MenubarSubContent`, `MenubarPortal`.
- `NavigationMenu`: top-level links with fly-out panels. Parts: `NavigationMenuList`, `NavigationMenuItem`, `NavigationMenuTrigger`, `NavigationMenuContent`, `NavigationMenuLink`, `NavigationMenuIndicator`, `NavigationMenuViewport`. `navigationMenuTriggerStyle` gives a plain link the trigger look.
- `Breadcrumb`: a path of links to the current page. Parts: `BreadcrumbList`, `BreadcrumbItem`, `BreadcrumbLink`, `BreadcrumbPage` (the current page), `BreadcrumbSeparator`, `BreadcrumbEllipsis` (hidden middle steps).
- `Pagination`: page links with previous and next. Parts: `PaginationContent`, `PaginationItem`, `PaginationLink`, `PaginationPrevious`, `PaginationNext`, `PaginationEllipsis`.
- `Tabs`: switch between views. Parts: `TabsList`, `TabsTrigger`, `TabsContent`.
- `Sidebar`: an app sidebar that can collapse. Parts: `SidebarHeader`, `SidebarContent`, `SidebarFooter`, `SidebarGroup`, `SidebarGroupLabel`, `SidebarGroupAction`, `SidebarGroupContent`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `SidebarMenuAction`, `SidebarMenuBadge`, `SidebarMenuSkeleton` (loading row), `SidebarMenuSub`, `SidebarMenuSubItem`, `SidebarMenuSubButton`, `SidebarInput` (search box), `SidebarSeparator`, `SidebarTrigger` (collapse button), `SidebarRail` (thin edge strip to toggle), `SidebarInset` (the main page area beside the sidebar).
- `ScrollToTop`: a button that returns to the top of the page.

## Feedback and loading

- `Alert`, `AlertTitle`, `AlertDescription`: a boxed message with a title and text.
- `Badge`, `badgeVariants`: a small label for status or counts. `badgeVariants` gives its classes.
- `Progress`: a progress bar.
- `Skeleton`: a grey placeholder while content loads.
- `Spinner`: a spinning loading ring.
- `PulseLoader`: three pulsing dots, re-exported from `react-spinners`.

## Layout and surfaces

- `Surface`: a background layer with elevation, optional shadow and border.
- `CardDescription`, `CardFooter`: the grey subtitle and the action row of a `Card`.
- `GlassCard`, `glassCardVariants`: a translucent card. `glassTones` lists the colour tones it accepts.
- `GlassCardIcon`, `glassCardIconVariants`: the icon tile inside a glass card, with the same tones.
- `Separator`: a divider line.
- `AspectRatio`: a box that keeps a fixed width-to-height ratio.
- `ScrollArea`, `ScrollBar`: a scroll region with styled scrollbars.
- `Accordion`: stacked sections that open and close. Parts: `AccordionItem`, `AccordionTrigger`, `AccordionContent`.
- `Collapsible`: one section that opens and closes. Parts: `CollapsibleTrigger`, `CollapsibleContent`.
- `Resizable`: panels the user drags to resize. Parts: `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle`.
- `Panel`: a titled work area. Parts: `PanelHeader`, `PanelHeadline` (the title), `PanelSection`, `PanelDivider`, `PanelFooter`.
- `ToolPanelGroup`, `ToolPanel`, `ToolPanelHandle`: resizable side panels for tool-style apps. A group keeps layout state, a panel is one pane, a handle is the drag bar between them. `useToolPanelGroup` reads the group state, for example which panel is maximized.
- `PanelExpandButton`: a maximize and restore button for a tool panel header.
- `PanelSkeleton`: a placeholder shown while saved panel layout loads.

## Data display

- `Avatar`, `AvatarImage`, `AvatarFallback`: a user picture with a fallback (such as initials) when the image fails.
- `Table` parts: `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHead` (header cell), `TableCell`, `TableCaption`.
- `Timeline` parts: `TimelineItem` (one event), `TimelineDot`, `TimelineConnector` (the line between dots), `TimelineSeparator` (groups dot and connector), `TimelineContent`, `TimelineTitle`, `TimelineDescription`.
- `Carousel` parts: `CarouselContent`, `CarouselItem`, `CarouselPrevious`, `CarouselNext`.
- `ChartContainer`: wraps a Recharts chart and sets colours from design tokens. `ChartStyle` writes the colour CSS. `ChartTooltip`, `ChartTooltipContent`: the hover tooltip. `ChartLegend`, `ChartLegendContent`: the legend.

## Helpers

- `Slot`: merges its props onto its single child element.
- `withAsChild`: lets a component render its child instead of its own element (the Radix-style `asChild` pattern).

## Hooks

Each hook has its own subpath under `@arki/ui/hooks/`.

- `useCopyToClipboard`: copy text and keep the last copied value.
- `useHotkeys`: run a function on a key combination.
- `useIsClient`: false on the server and during hydration, true after.
- `useIsTablet`, `useIsDesktop`, `useIsTabletOrDesktop`: true when the screen matches that size. Safe for server rendering.
- `useIsTouchDevice`: true when the main pointer is a finger.
- `useLocalStorage`: state kept in local storage and synced across tabs. `writeStorage` and `deleteFromStorage` set and remove a key from outside React.
- `useLongPress`: handlers that tell a long press from a click.
- `useSwipeGesture`: swipe and tap detection. `useNumberSwipeGesture` maps swipes to the digits 1 to 9.
- `useTouchFeedback`: haptic, visual and sound feedback for a touch.
- `usePagination`: page numbers and controls for a paged list.
- `useTimeout`: run a callback after a delay, cleared on unmount.
- `useToggle`, `useToggleState`: flip a boolean or cycle through a list of values.
