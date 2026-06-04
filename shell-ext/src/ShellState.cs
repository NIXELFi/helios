using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;

namespace HeliosShell
{
    /// <summary>
    /// Cached reader for the bridge-written %LOCALAPPDATA%\Helios\shell-state.json
    /// (normalized-path → { state, name, by, ... }). Icon-overlay handlers call
    /// StateFor() for EVERY file Explorer paints, so this must be fast: it keeps
    /// the parsed map in memory and only re-reads when the file's mtime changes.
    /// Thread-safe — Explorer drives overlay/menu handlers from several threads.
    /// </summary>
    internal static class ShellState
    {
        private static readonly object Gate = new object();
        private static Dictionary<string, string> _states;                       // normPath -> state
        private static Dictionary<string, Dictionary<string, object>> _entries;  // normPath -> full entry
        private static string _vaultRoot;
        private static DateTime _mtimeUtc = DateTime.MinValue;
        private static long _size = -1;

        private static string StatePath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Helios", "shell-state.json");

        /// <summary>Match the bridge's norm_path: backslashes→/, no trailing
        /// slash, lowercase. Lets a path from Explorer line up with the cache.</summary>
        internal static string NormPath(string p) =>
            string.IsNullOrEmpty(p) ? "" : p.Replace('\\', '/').TrimEnd('/').ToLowerInvariant();

        private static void EnsureFreshLocked()
        {
            try
            {
                var fi = new FileInfo(StatePath);
                if (!fi.Exists)
                {
                    _states = null;
                    _entries = null;
                    _vaultRoot = null;
                    return;
                }
                // Cheap freshness check: mtime + size. Either changing means the
                // bridge rewrote the cache and we must re-parse.
                if (_states != null && fi.LastWriteTimeUtc == _mtimeUtc && fi.Length == _size) return;

                var json = File.ReadAllText(StatePath);
                var ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                var root = ser.Deserialize<Dictionary<string, object>>(json);
                var files = Bridge.GetObj(root, "files");
                var states = new Dictionary<string, string>(StringComparer.Ordinal);
                var entries = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
                if (files != null)
                {
                    foreach (var kv in files)
                    {
                        if (!(kv.Value is Dictionary<string, object> e)) continue;
                        states[kv.Key] = Bridge.GetStr(e, "state");
                        entries[kv.Key] = e;
                    }
                }
                _states = states;
                _entries = entries;
                _vaultRoot = Bridge.GetStr(root, "vaultRoot");
                _mtimeUtc = fi.LastWriteTimeUtc;
                _size = fi.Length;
            }
            catch
            {
                // Parse/IO error (e.g. a half-written file) — keep the last-good
                // cache so overlays don't flicker; next call retries.
            }
        }

        /// <summary>Vault state for a path: "out-me" | "out-other" | "available",
        /// or null when the path isn't a tracked vault file.</summary>
        internal static string StateFor(string path)
        {
            lock (Gate)
            {
                EnsureFreshLocked();
                if (_states == null) return null;
                return _states.TryGetValue(NormPath(path), out var s) ? s : null;
            }
        }

        /// <summary>Full cache entry for a path (state, name, by, fileId), or null.</summary>
        internal static Dictionary<string, object> EntryFor(string path)
        {
            lock (Gate)
            {
                EnsureFreshLocked();
                if (_entries == null) return null;
                return _entries.TryGetValue(NormPath(path), out var e) ? e : null;
            }
        }

        /// <summary>True if the path sits under the user's vault root — used to
        /// decide whether to even offer the Helios menu / overlays.</summary>
        internal static bool IsUnderVault(string path)
        {
            lock (Gate)
            {
                EnsureFreshLocked();
                if (string.IsNullOrEmpty(_vaultRoot) || string.IsNullOrEmpty(path)) return false;
                return NormPath(path).StartsWith(NormPath(_vaultRoot) + "/", StringComparison.Ordinal);
            }
        }
    }
}
