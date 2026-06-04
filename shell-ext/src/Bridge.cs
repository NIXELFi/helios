using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace HeliosShell
{
    /// <summary>
    /// Thin client for the Helios desktop app's localhost bridge — the SAME API
    /// the SOLIDWORKS add-in uses, so Explorer actions and the add-in stay in
    /// lockstep. Discovery + auth come from %LOCALAPPDATA%\Helios\bridge.json
    /// ({ port, token }, rotated each Helios launch); we read it fresh per call
    /// and present the token as a bearer. We never send an Origin header — the
    /// bridge rejects requests that have one (a CSRF guard).
    /// </summary>
    internal static class Bridge
    {
        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };

        private static string LocalAppData =>
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        private static string DiscoveryPath => Path.Combine(LocalAppData, "Helios", "bridge.json");

        internal sealed class Result
        {
            public bool Ok;
            public bool Unreachable;
            public int HttpStatus;
            public string Error;
            public Dictionary<string, object> Json;
        }

        private struct Discovery { public int Port; public string Token; }

        private static Discovery? ReadDiscovery()
        {
            try
            {
                if (!File.Exists(DiscoveryPath)) return null;
                var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(DiscoveryPath));
                if (d == null || !d.ContainsKey("port") || !d.ContainsKey("token")) return null;
                return new Discovery { Port = Convert.ToInt32(d["port"]), Token = Convert.ToString(d["token"]) };
            }
            catch { return null; }
        }

        /// <summary>True when the Helios desktop app is running + reachable.</summary>
        internal static bool IsHeliosRunning() => ReadDiscovery() != null;

        private static string Ser(string s) => new JavaScriptSerializer().Serialize(s ?? "");
        private static string Enc(string s) => Uri.EscapeDataString(s ?? "");

        private static async Task<Result> SendAsync(HttpMethod method, string pathAndQuery, string jsonBody)
        {
            var disc = ReadDiscovery();
            if (disc == null) return new Result { Unreachable = true, Error = "Helios isn't running." };

            var url = $"http://127.0.0.1:{disc.Value.Port}{pathAndQuery}";
            using (var req = new HttpRequestMessage(method, url))
            {
                req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + disc.Value.Token);
                if (jsonBody != null) req.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");

                HttpResponseMessage resp;
                try { resp = await Http.SendAsync(req).ConfigureAwait(false); }
                catch { return new Result { Unreachable = true, Error = "Helios isn't reachable." }; }

                using (resp)
                {
                    var body = resp.Content != null ? await resp.Content.ReadAsStringAsync().ConfigureAwait(false) : "";
                    Dictionary<string, object> json = null;
                    try { if (!string.IsNullOrEmpty(body)) json = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body); }
                    catch { /* non-JSON (guard plain-text) */ }
                    var r = new Result { Ok = resp.IsSuccessStatusCode, HttpStatus = (int)resp.StatusCode, Json = json };
                    if (!r.Ok)
                        r.Error = (json != null && json.ContainsKey("error")) ? Convert.ToString(json["error"])
                                : (string.IsNullOrEmpty(body) ? $"HTTP {(int)resp.StatusCode}" : body);
                    return r;
                }
            }
        }

        // Synchronous wrappers — shell handlers run on Explorer's threads and the
        // calls are quick localhost round-trips. GetAwaiter().GetResult() avoids
        // a deadlock risk vs .Result (there's no captured SynchronizationContext
        // on the worker threads Explorer uses for these handlers).
        private static Result Send(HttpMethod m, string path, string body) =>
            SendAsync(m, path, body).GetAwaiter().GetResult();

        internal static Result Status(string path) => Send(HttpMethod.Get, "/status?path=" + Enc(path), null);
        internal static Result Versions(string path) => Send(HttpMethod.Get, "/versions?path=" + Enc(path), null);
        internal static Result Checkout(string path) => Send(HttpMethod.Post, "/checkout", "{\"path\":" + Ser(path) + "}");
        internal static Result CancelCheckout(string path) => Send(HttpMethod.Post, "/cancel-checkout", "{\"path\":" + Ser(path) + "}");
        internal static Result GetLatest(string path) => Send(HttpMethod.Post, "/get-latest", "{\"path\":" + Ser(path) + "}");
        internal static Result Add(string path) => Send(HttpMethod.Post, "/add", "{\"path\":" + Ser(path) + "}");

        internal static Result CheckIn(string path, string comment)
        {
            var c = comment == null ? "null" : Ser(comment);
            return Send(HttpMethod.Post, "/checkin", "{\"path\":" + Ser(path) + ",\"comment\":" + c + "}");
        }

        // --- tiny JSON-dictionary helpers (JavaScriptSerializer shapes) --------
        internal static bool GetBool(Dictionary<string, object> d, string k) =>
            d != null && d.TryGetValue(k, out var v) && v is bool b && b;

        internal static string GetStr(Dictionary<string, object> d, string k) =>
            (d != null && d.TryGetValue(k, out var v) && v != null) ? Convert.ToString(v) : null;

        internal static Dictionary<string, object> GetObj(Dictionary<string, object> d, string k) =>
            (d != null && d.TryGetValue(k, out var v)) ? v as Dictionary<string, object> : null;
    }
}
