import {
  Activity,
  ArrowLeft,
  ArrowUp,
  CalendarDays,
  Check,
  ChevronDown,
  FileUp,
  FolderOpen,
  Kanban,
  LoaderCircle,
  Pickaxe,
  Radar,
  Search,
  Settings2,
  Smile,
  Star,
} from "lucide-react";

function chatFirstIcon(Component, name) {
  function ChatFirstIcon(props) {
    return (
      <Component {...props} data-icon={name} aria-hidden="true" focusable="false" strokeWidth={2} />
    );
  }
  ChatFirstIcon.displayName = `${Component.displayName || Component.name || "Icon"}Icon`;
  return ChatFirstIcon;
}

export const SettingsIcon = chatFirstIcon(Settings2, "settings-2");
export const CalendarIcon = chatFirstIcon(CalendarDays, "calendar-days");
export const PulseIcon = chatFirstIcon(Activity, "activity");
export const ChevronDownIcon = chatFirstIcon(ChevronDown, "chevron-down");
export const CheckIcon = chatFirstIcon(Check, "check");
export const SearchIcon = chatFirstIcon(Search, "search");
export const ArrowLeftIcon = chatFirstIcon(ArrowLeft, "arrow-left");
export const UploadIcon = chatFirstIcon(FileUp, "file-up");
export const RadarIcon = chatFirstIcon(Radar, "radar");
export const SpinnerIcon = chatFirstIcon(LoaderCircle, "loader-circle");
export const FolderIcon = chatFirstIcon(FolderOpen, "folder-open");
export const PeopleIcon = chatFirstIcon(Smile, "smile");
export const SendUpIcon = chatFirstIcon(ArrowUp, "arrow-up");
export const KanbanIcon = chatFirstIcon(Kanban, "kanban");
export const PickaxeIcon = chatFirstIcon(Pickaxe, "pickaxe");
export const StarIcon = chatFirstIcon(Star, "star");
