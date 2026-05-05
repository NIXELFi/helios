import type { ChannelMeta } from "@helios/store";

interface Props {
  /** Current channel id. May be the empty string for "(none)". */
  value: string;
  onChange: (next: string) => void;
  channels: ChannelMeta[];
  /** When true, prepend a "— none —" option that emits "" on select. */
  allowEmpty?: boolean;
  className?: string;
}

/** Dropdown of all channels in the primary session. Options show
 *  `id  ·  display_name` so the user can recognize either form. Channels are
 *  grouped by their `group` field to keep long lists scannable. If `value`
 *  isn't in `channels` (e.g. the workspace was saved against a different CSV)
 *  it's still shown so the editor doesn't silently drop the assignment. */
export function ChannelPicker({ value, onChange, channels, allowEmpty, className }: Props) {
  const sorted = [...channels].sort((a, b) => {
    if (a.group !== b.group) return a.group.localeCompare(b.group);
    return a.id.localeCompare(b.id);
  });
  const groups = new Map<string, ChannelMeta[]>();
  for (const c of sorted) {
    const list = groups.get(c.group) ?? [];
    list.push(c);
    groups.set(c.group, list);
  }
  const isUnknown = value !== "" && !channels.some((c) => c.id === value);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={
        "bg-[#0E0E10] border border-[#2A2C32] px-1 text-xs text-[#D8DCE2] " +
        "focus:outline-none focus:border-[#FFC627] cursor-pointer " +
        (className ?? "")
      }
    >
      {allowEmpty && <option value="">— none —</option>}
      {isUnknown && <option value={value}>{value} · (not in this session)</option>}
      {[...groups.entries()].map(([group, list]) => (
        <optgroup key={group} label={group}>
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id}{c.display_name && c.display_name !== c.id ? ` · ${c.display_name}` : ""}
              {c.units ? ` (${c.units})` : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
