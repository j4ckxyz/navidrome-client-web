import { Show, type Component, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  Calendar,
  Check,
  ChevronRight,
  Clock,
  Disc,
  FileText,
  GripVertical,
  Heart,
  Home,
  Keyboard,
  List,
  ListMusic,
  LogOut,
  Mic,
  Menu,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  Repeat1,
  Search,
  Server,
  Settings,
  Share2,
  Shuffle,
  SkipBack,
  SkipForward,
  Star,
  Tag,
  Trash2,
  TrendingUp,
  Upload,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-solid";

export type IconName =
  | "play"
  | "pause"
  | "next"
  | "prev"
  | "shuffle"
  | "repeat"
  | "repeat-one"
  | "heart"
  | "heart-filled"
  | "search"
  | "queue"
  | "lyrics"
  | "settings"
  | "volume"
  | "volume-low"
  | "volume-mute"
  | "plus"
  | "more"
  | "close"
  | "home"
  | "keyboard"
  | "disc"
  | "mic"
  | "list"
  | "logout"
  | "menu"
  | "star"
  | "star-filled"
  | "clock"
  | "trending"
  | "calendar"
  | "tag"
  | "check"
  | "chevron-right"
  | "share"
  | "edit"
  | "trash"
  | "grip"
  | "server"
  | "upload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LucideComp = Component<any>;

// Icons that should be rendered filled (fill = currentColor, no stroke).
const FILLED_ICONS = new Set<IconName>(["heart-filled", "star-filled"]);

const LUCIDE_MAP: Record<IconName, LucideComp> = {
  play: Play,
  pause: Pause,
  next: SkipForward,
  prev: SkipBack,
  shuffle: Shuffle,
  repeat: Repeat,
  "repeat-one": Repeat1,
  heart: Heart,
  "heart-filled": Heart,
  search: Search,
  queue: ListMusic,
  lyrics: FileText,
  settings: Settings,
  volume: Volume2,
  "volume-low": Volume1,
  "volume-mute": VolumeX,
  plus: Plus,
  more: MoreVertical,
  close: X,
  home: Home,
  keyboard: Keyboard,
  disc: Disc,
  mic: Mic,
  list: List,
  logout: LogOut,
  menu: Menu,
  star: Star,
  "star-filled": Star,
  clock: Clock,
  trending: TrendingUp,
  calendar: Calendar,
  tag: Tag,
  check: Check,
  "chevron-right": ChevronRight,
  share: Share2,
  edit: Pencil,
  trash: Trash2,
  grip: GripVertical,
  server: Server,
  upload: Upload,
};

export interface IconProps {
  name: IconName;
  size?: number;
  class?: string;
  "stroke-width"?: number;
}

export function Icon(props: IconProps): JSX.Element {
  return (
    <Show when={LUCIDE_MAP[props.name]}>
      {(Comp) => {
        return (
          <Dynamic
            component={Comp()}
            size={props.size ?? 20}
            class={props.class}
            stroke-width={props["stroke-width"] ?? 1.8}
            fill={FILLED_ICONS.has(props.name) ? "currentColor" : "none"}
            stroke={FILLED_ICONS.has(props.name) ? "none" : "currentColor"}
            aria-hidden="true"
          />
        );
      }}
    </Show>
  );
}
