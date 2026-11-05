// Renders every @arki/native-ui component once, in a release iOS build on Hermes.
// Each check is a native view that must lay out (`onLayout` fires only after the native
// side has mounted and measured it). Overlay components (dialog, popover, menus, select)
// are opened, so their content renders through the portal too. When every check has laid
// out, or the deadline passes, the app writes its result to `Documents/arki-app-smoke.txt`;
// `arki-runtimes` reads that file from the simulator. Nothing is mocked.
import { PortalHost } from '@rn-primitives/portal';
import { File, Paths } from 'expo-file-system';
import { Star } from 'phosphor-react-native';
import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { FadeIn } from 'react-native-reanimated';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  AlertTitle,
  AspectRatio,
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  badgeTextVariants,
  badgeVariants,
  Button,
  buttonTextVariants,
  buttonVariants,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Icon,
  Input,
  Label,
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
  NativeOnlyAnimatedView,
  NativeSelectScrollView,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Text,
  TextClassContext,
  Textarea,
  Toggle,
  ToggleGroup,
  ToggleGroupIcon,
  ToggleGroupItem,
  ToggleIcon,
  toggleVariants,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@arki/native-ui';

/** Every view that must lay out. One list: the probes name these, and the result counts them. */
const CHECKS = [
  'accordion',
  'accordion content',
  'alert',
  'alert dialog trigger',
  'alert dialog content',
  'aspect ratio',
  'avatar',
  'badge',
  'button',
  'card',
  'checkbox',
  'collapsible',
  'collapsible content',
  'context menu trigger',
  'context menu content',
  'dialog trigger',
  'dialog content',
  'dropdown menu trigger',
  'dropdown menu content',
  'hover card trigger',
  'hover card content',
  'icon',
  'input',
  'label',
  'menubar',
  'native only animated view',
  'popover trigger',
  'popover content',
  'progress',
  'radio group',
  'select trigger',
  'select content',
  'separator',
  'skeleton',
  'switch',
  'tabs',
  'tabs content',
  'text',
  'textarea',
  'toggle',
  'toggle group',
  'tooltip trigger',
  'tooltip content',
  'variant helpers',
] as const;
type Check = (typeof CHECKS)[number];

const RESULT_FILE = 'arki-app-smoke.txt';
const DEADLINE_MS = 30_000;

type Outcome = { readonly laidOut: Set<Check>; readonly failures: string[]; done: boolean };
const outcome: Outcome = { laidOut: new Set(), failures: [], done: false };

function engine(): string {
  const hermes = (globalThis as { HermesInternal?: { getRuntimeProperties?: () => Record<string, unknown> } })
    .HermesInternal;
  const release = hermes?.getRuntimeProperties?.()['OSS Release Version'];
  const version = Platform.constants.reactNativeVersion;
  const reactNative = `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
  return `${hermes ? `hermes ${typeof release === 'string' ? release : 'unknown'}` : 'not hermes'}, react-native ${reactNative}, iOS ${String(Platform.Version)}`;
}

function writeResult(): void {
  if (outcome.done) return;
  outcome.done = true;
  const missing = CHECKS.filter(name => !outcome.laidOut.has(name)).map(name => `FAIL ${name}: did not lay out`);
  const failures = [...outcome.failures, ...missing];
  const lines =
    failures.length === 0
      ? [`${String(CHECKS.length)} smoke checks passed (${engine()})`]
      : [...failures, `${String(CHECKS.length - missing.length)}/${String(CHECKS.length)} checks laid out (${engine()})`];
  const file = new File(Paths.document, RESULT_FILE);
  if (file.exists) file.delete();
  file.create();
  file.write(`${lines.join('\n')}\n`);
}

function laidOut(name: Check): void {
  outcome.laidOut.add(name);
  if (outcome.laidOut.size === CHECKS.length) writeResult();
}

function fail(message: string): void {
  outcome.failures.push(`FAIL ${message}`);
  writeResult();
}

// An error thrown outside a render (an event, a timer) fails the run too.
const errorUtils = (
  globalThis as {
    ErrorUtils?: { setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => void };
  }
).ErrorUtils;
errorUtils?.setGlobalHandler(error => fail(`uncaught: ${error instanceof Error ? error.message : String(error)}`));

class Boundary extends React.Component<{ name: Check; children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: Error): void {
    fail(`${this.props.name}: ${error.message}`);
  }
  override render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** A native view that reports `name` once it has laid out. */
function Mark({ name, onReady }: { name: Check; onReady?: () => void }) {
  return (
    <View
      style={{ minHeight: 1, minWidth: 1 }}
      onLayout={() => {
        laidOut(name);
        onReady?.();
      }}
    />
  );
}

/** One component under test: rendered inside an error boundary, with a mark after it. */
function Probe({ name, children }: { name: Check; children: React.ReactNode }) {
  return (
    <Boundary name={name}>
      <View>
        {children}
        <Mark name={name} />
      </View>
    </Boundary>
  );
}

/** Opens an overlay once its trigger has laid out: the primitives measure the trigger to place the content. */
function useOpenAfterLayout<TriggerRef extends { open: () => void }>(): [React.RefObject<TriggerRef | null>, () => void] {
  const ref = React.useRef<TriggerRef | null>(null);
  return [ref, () => ref.current?.open()];
}

/** The state of a menu's checkbox item and radio group. */
function useMenuItems() {
  const [checked, setChecked] = React.useState(true);
  const [radio, setRadio] = React.useState('a');
  return { checked, setChecked, radio, setRadio };
}

function InlineComponents() {
  const [presses, setPresses] = React.useState(0);
  const [menu, setMenu] = React.useState<string>();
  const item = useMenuItems();
  const [checked, setChecked] = React.useState(true);
  const [on, setOn] = React.useState(true);
  const [radio, setRadio] = React.useState('one');
  const [pressed, setPressed] = React.useState(true);
  const [group, setGroup] = React.useState<string[]>(['bold']);
  const [tab, setTab] = React.useState('first');
  const [open, setOpen] = React.useState(true);
  const variants =
    typeof buttonVariants({ variant: 'outline' }) === 'string' &&
    typeof buttonTextVariants({ variant: 'outline' }) === 'string' &&
    typeof badgeVariants({ variant: 'secondary' }) === 'string' &&
    typeof badgeTextVariants({ variant: 'secondary' }) === 'string' &&
    typeof toggleVariants({ variant: 'outline' }) === 'string';
  return (
    <>
      <Probe name="text">
        <TextClassContext.Provider value="text-sm">
          <Text>Text in a class context</Text>
        </TextClassContext.Provider>
      </Probe>
      <Probe name="button">
        <Button variant="outline" onPress={() => setPresses(count => count + 1)}>
          <Text>Button ({String(presses)})</Text>
        </Button>
      </Probe>
      <Probe name="badge">
        <Badge variant="secondary">
          <Text>Badge</Text>
        </Badge>
      </Probe>
      <Probe name="alert">
        <Alert icon={Star}>
          <AlertTitle>Alert title</AlertTitle>
          <AlertDescription>Alert description</AlertDescription>
        </Alert>
      </Probe>
      <Probe name="card">
        <Card>
          <CardHeader>
            <CardTitle>Card title</CardTitle>
            <CardDescription>Card description</CardDescription>
          </CardHeader>
          <CardContent>
            <Text>Card content</Text>
          </CardContent>
          <CardFooter>
            <Text>Card footer</Text>
          </CardFooter>
        </Card>
      </Probe>
      <Probe name="accordion">
        <Accordion type="single" collapsible defaultValue="item">
          <AccordionItem value="item">
            <AccordionTrigger>
              <Text>Accordion trigger</Text>
            </AccordionTrigger>
            <AccordionContent>
              <Text>Accordion content</Text>
              <Mark name="accordion content" />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Probe>
      <Probe name="collapsible">
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger>
            <Text>Collapsible trigger</Text>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Mark name="collapsible content" />
          </CollapsibleContent>
        </Collapsible>
      </Probe>
      <Probe name="aspect ratio">
        <AspectRatio ratio={16 / 9}>
          <View style={{ flex: 1 }} />
        </AspectRatio>
      </Probe>
      <Probe name="avatar">
        <Avatar alt="Ada Lovelace">
          <AvatarImage source={{ uri: 'https://example.invalid/avatar.png' }} />
          <AvatarFallback>
            <Text>AL</Text>
          </AvatarFallback>
        </Avatar>
      </Probe>
      <Probe name="checkbox">
        <Checkbox checked={checked} onCheckedChange={setChecked} />
      </Probe>
      <Probe name="switch">
        <Switch checked={on} onCheckedChange={setOn} />
      </Probe>
      <Probe name="radio group">
        <RadioGroup value={radio} onValueChange={setRadio}>
          <RadioGroupItem value="one" />
          <RadioGroupItem value="two" />
        </RadioGroup>
      </Probe>
      <Probe name="label">
        <Label nativeID="name-label">Name</Label>
      </Probe>
      <Probe name="input">
        <Input placeholder="Input" aria-labelledby="name-label" />
      </Probe>
      <Probe name="textarea">
        <Textarea placeholder="Textarea" />
      </Probe>
      <Probe name="icon">
        <Icon as={Star} size={16} />
      </Probe>
      <Probe name="progress">
        <Progress value={40} />
      </Probe>
      <Probe name="separator">
        <Separator />
      </Probe>
      <Probe name="skeleton">
        <Skeleton className="h-4 w-16" />
      </Probe>
      <Probe name="toggle">
        <Toggle pressed={pressed} onPressedChange={setPressed}>
          <ToggleIcon as={Star} />
        </Toggle>
      </Probe>
      <Probe name="toggle group">
        <ToggleGroup type="multiple" value={group} onValueChange={setGroup}>
          <ToggleGroupItem value="bold" isFirst>
            <ToggleGroupIcon as={Star} />
          </ToggleGroupItem>
          <ToggleGroupItem value="italic" isLast>
            <Text>I</Text>
          </ToggleGroupItem>
        </ToggleGroup>
      </Probe>
      <Probe name="tabs">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="first">
              <Text>First</Text>
            </TabsTrigger>
            <TabsTrigger value="second">
              <Text>Second</Text>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="first">
            <Mark name="tabs content" />
          </TabsContent>
        </Tabs>
      </Probe>
      <Probe name="native only animated view">
        <NativeOnlyAnimatedView entering={FadeIn}>
          <Text>Animated</Text>
        </NativeOnlyAnimatedView>
      </Probe>
      <Probe name="menubar">
        <Menubar value={menu} onValueChange={setMenu}>
          <MenubarMenu value="file">
            <MenubarTrigger>
              <Text>File</Text>
            </MenubarTrigger>
            <MenubarContent>
              <MenubarGroup>
                <MenubarLabel>Menubar</MenubarLabel>
                <MenubarItem>
                  <Text>Item</Text>
                  <MenubarShortcut>⌘N</MenubarShortcut>
                </MenubarItem>
                <MenubarCheckboxItem checked={item.checked} onCheckedChange={item.setChecked}>
                  <Text>Checkbox item</Text>
                </MenubarCheckboxItem>
                <MenubarSeparator />
                <MenubarRadioGroup value={item.radio} onValueChange={item.setRadio}>
                  <MenubarRadioItem value="a">
                    <Text>Radio item</Text>
                  </MenubarRadioItem>
                </MenubarRadioGroup>
                <MenubarSub>
                  <MenubarSubTrigger>
                    <Text>Sub menu</Text>
                  </MenubarSubTrigger>
                  <MenubarSubContent>
                    <MenubarItem>
                      <Text>Sub item</Text>
                    </MenubarItem>
                  </MenubarSubContent>
                </MenubarSub>
              </MenubarGroup>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>
      </Probe>
      {variants ? <Mark name="variant helpers" /> : null}
    </>
  );
}

function Overlays() {
  const [dialog, setDialog] = React.useState(false);
  const [alertDialog, setAlertDialog] = React.useState(false);
  const [popoverRef, openPopover] = useOpenAfterLayout<React.ComponentRef<typeof PopoverTrigger>>();
  const [tooltipRef, openTooltip] = useOpenAfterLayout<React.ComponentRef<typeof TooltipTrigger>>();
  const [hoverCardRef, openHoverCard] = useOpenAfterLayout<React.ComponentRef<typeof HoverCardTrigger>>();
  const [dropdownRef, openDropdown] = useOpenAfterLayout<React.ComponentRef<typeof DropdownMenuTrigger>>();
  const [contextMenuRef, openContextMenu] = useOpenAfterLayout<React.ComponentRef<typeof ContextMenuTrigger>>();
  const dropdownItem = useMenuItems();
  const contextItem = useMenuItems();
  const [selectRef, openSelect] = useOpenAfterLayout<React.ComponentRef<typeof SelectTrigger>>();
  return (
    <>
      <Boundary name="dialog content">
        <Dialog open={dialog} onOpenChange={setDialog}>
          <DialogTrigger>
            <Text>Dialog trigger</Text>
            <Mark name="dialog trigger" onReady={() => setDialog(true)} />
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Dialog title</DialogTitle>
              <DialogDescription>Dialog description</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose>
                <Text>Close</Text>
              </DialogClose>
            </DialogFooter>
            <Mark name="dialog content" />
          </DialogContent>
        </Dialog>
      </Boundary>
      <Boundary name="alert dialog content">
        <AlertDialog open={alertDialog} onOpenChange={setAlertDialog}>
          <AlertDialogTrigger>
            <Text>Alert dialog trigger</Text>
            <Mark name="alert dialog trigger" onReady={() => setAlertDialog(true)} />
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Alert dialog title</AlertDialogTitle>
              <AlertDialogDescription>Alert dialog description</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                <Text>Cancel</Text>
              </AlertDialogCancel>
              <AlertDialogAction>
                <Text>Continue</Text>
              </AlertDialogAction>
            </AlertDialogFooter>
            <Mark name="alert dialog content" />
          </AlertDialogContent>
        </AlertDialog>
      </Boundary>
      <Boundary name="popover content">
        <Popover>
          <PopoverTrigger ref={popoverRef}>
            <Text>Popover trigger</Text>
            <Mark name="popover trigger" onReady={openPopover} />
          </PopoverTrigger>
          <PopoverContent>
            <Text>Popover content</Text>
            <Mark name="popover content" />
          </PopoverContent>
        </Popover>
      </Boundary>
      <Boundary name="tooltip content">
        <Tooltip>
          <TooltipTrigger ref={tooltipRef}>
            <Text>Tooltip trigger</Text>
            <Mark name="tooltip trigger" onReady={openTooltip} />
          </TooltipTrigger>
          <TooltipContent>
            <Text>Tooltip content</Text>
            <Mark name="tooltip content" />
          </TooltipContent>
        </Tooltip>
      </Boundary>
      <Boundary name="hover card content">
        <HoverCard>
          <HoverCardTrigger ref={hoverCardRef}>
            <Text>Hover card trigger</Text>
            <Mark name="hover card trigger" onReady={openHoverCard} />
          </HoverCardTrigger>
          <HoverCardContent>
            <Text>Hover card content</Text>
            <Mark name="hover card content" />
          </HoverCardContent>
        </HoverCard>
      </Boundary>
      <Boundary name="dropdown menu content">
        <DropdownMenu>
          <DropdownMenuTrigger ref={dropdownRef}>
            <Text>Dropdown menu trigger</Text>
            <Mark name="dropdown menu trigger" onReady={openDropdown} />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Dropdown menu</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem>
                <Text>Item</Text>
                <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem checked={dropdownItem.checked} onCheckedChange={dropdownItem.setChecked}>
                <Text>Checkbox item</Text>
              </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={dropdownItem.radio} onValueChange={dropdownItem.setRadio}>
              <DropdownMenuRadioItem value="a">
                <Text>Radio item</Text>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Text>Sub menu</Text>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>
                  <Text>Sub item</Text>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <Mark name="dropdown menu content" />
          </DropdownMenuContent>
        </DropdownMenu>
      </Boundary>
      <Boundary name="context menu content">
        <ContextMenu>
          <ContextMenuTrigger ref={contextMenuRef}>
            <Text>Context menu trigger</Text>
            <Mark name="context menu trigger" onReady={openContextMenu} />
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuLabel>Context menu</ContextMenuLabel>
            <ContextMenuGroup>
              <ContextMenuItem>
                <Text>Item</Text>
                <ContextMenuShortcut>⌘C</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuCheckboxItem checked={contextItem.checked} onCheckedChange={contextItem.setChecked}>
                <Text>Checkbox item</Text>
              </ContextMenuCheckboxItem>
            </ContextMenuGroup>
            <ContextMenuSeparator />
            <ContextMenuRadioGroup value={contextItem.radio} onValueChange={contextItem.setRadio}>
              <ContextMenuRadioItem value="a">
                <Text>Radio item</Text>
              </ContextMenuRadioItem>
            </ContextMenuRadioGroup>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Text>Sub menu</Text>
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem>
                  <Text>Sub item</Text>
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <Mark name="context menu content" />
          </ContextMenuContent>
        </ContextMenu>
      </Boundary>
      <Boundary name="select content">
        <Select defaultValue={{ value: 'apple', label: 'Apple' }}>
          <SelectTrigger ref={selectRef}>
            <SelectValue placeholder="Pick a fruit" />
            <Mark name="select trigger" onReady={openSelect} />
          </SelectTrigger>
          <SelectContent>
            <SelectScrollUpButton />
            <NativeSelectScrollView>
              <SelectGroup>
                <SelectLabel>Fruit</SelectLabel>
                <SelectItem value="apple" label="Apple" />
                <SelectSeparator />
                <SelectItem value="pear" label="Pear" />
              </SelectGroup>
            </NativeSelectScrollView>
            <SelectScrollDownButton />
            <Mark name="select content" />
          </SelectContent>
        </Select>
      </Boundary>
    </>
  );
}

export function App() {
  React.useEffect(() => {
    const timer = setTimeout(writeResult, DEADLINE_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View style={{ flex: 1, paddingTop: 60 }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
        <InlineComponents />
        <Overlays />
      </ScrollView>
      <PortalHost />
    </View>
  );
}
