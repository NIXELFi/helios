using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace HeliosVault
{
    /// <summary>
    /// Client for the Helios desktop app's localhost "bridge" API (see
    /// apps/desktop/src-tauri/src/bridge/). The add-in is a thin client: it asks
    /// the running Helios app about the active document's vault state and drives
    /// check-out, so all auth/vault logic stays in one place.
    ///
    /// Discovery + auth: the running Helios app writes
    /// %LOCALAPPDATA%\Helios\bridge.json = { port, token } on launch. We read it
    /// fresh per call (port + token rotate each Helios launch) and present the
    /// token as a bearer. We never send an Origin header — the bridge rejects any
    /// request that has one, as a CSRF guard.
    /// </summary>
    internal sealed class HeliosBridge
    {
        // One client for the process; we set the auth header per request since the
        // token can change when Helios restarts.
        private static readonly HttpClient Http = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(15),
        };

        private static string DiscoveryPath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Helios", "bridge.json");

        /// <summary>True-ish result of a bridge call, or an error to show the user.</summary>
        internal sealed class BridgeResult
        {
            public bool Ok;
            /// <summary>True only when Helios isn't running / not reachable.</summary>
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
                var ser = new JavaScriptSerializer();
                var d = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(DiscoveryPath));
                if (d == null || !d.ContainsKey("port") || !d.ContainsKey("token")) return null;
                return new Discovery
                {
                    Port = Convert.ToInt32(d["port"]),
                    Token = Convert.ToString(d["token"]),
                };
            }
            catch
            {
                return null;
            }
        }

        private static async Task<BridgeResult> SendAsync(HttpMethod method, string pathAndQuery, string jsonBody)
        {
            var disc = ReadDiscovery();
            if (disc == null)
            {
                return new BridgeResult { Unreachable = true, Error = "Helios isn't running (no bridge found)." };
            }

            var url = $"http://127.0.0.1:{disc.Value.Port}{pathAndQuery}";
            using (var req = new HttpRequestMessage(method, url))
            {
                req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + disc.Value.Token);
                if (jsonBody != null)
                {
                    req.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
                }

                HttpResponseMessage resp;
                try
                {
                    resp = await Http.SendAsync(req).ConfigureAwait(false);
                }
                catch
                {
                    // Connection refused / DNS / timeout => Helios not up (stale
                    // discovery file is the common cause after Helios closes).
                    return new BridgeResult { Unreachable = true, Error = "Helios isn't reachable." };
                }

                using (resp)
                {
                    var body = resp.Content != null
                        ? await resp.Content.ReadAsStringAsync().ConfigureAwait(false)
                        : "";
                    Dictionary<string, object> json = null;
                    try
                    {
                        if (!string.IsNullOrEmpty(body))
                            json = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(body);
                    }
                    catch { /* non-JSON body (e.g. guard plain-text 401/403) */ }

                    var result = new BridgeResult
                    {
                        Ok = resp.IsSuccessStatusCode,
                        HttpStatus = (int)resp.StatusCode,
                        Json = json,
                    };
                    if (!result.Ok)
                    {
                        result.Error = (json != null && json.ContainsKey("error"))
                            ? Convert.ToString(json["error"])
                            : (string.IsNullOrEmpty(body) ? $"HTTP {(int)resp.StatusCode}" : body);
                    }
                    return result;
                }
            }
        }

        private static string Enc(string s) => Uri.EscapeDataString(s ?? "");
        private static string Ser(string s) => new JavaScriptSerializer().Serialize(s ?? "");

        public Task<BridgeResult> StatusAsync(string filePath) =>
            SendAsync(HttpMethod.Get, "/status?path=" + Enc(filePath), null);

        public Task<BridgeResult> VersionsAsync(string filePath) =>
            SendAsync(HttpMethod.Get, "/versions?path=" + Enc(filePath), null);

        public Task<BridgeResult> CheckoutAsync(string filePath) =>
            SendAsync(HttpMethod.Post, "/checkout", "{\"path\":" + Ser(filePath) + "}");

        public Task<BridgeResult> CheckInAsync(string filePath, string comment)
        {
            var c = comment == null ? "null" : Ser(comment);
            return SendAsync(HttpMethod.Post, "/checkin", "{\"path\":" + Ser(filePath) + ",\"comment\":" + c + "}");
        }

        public Task<BridgeResult> GetLatestAsync(string filePath) =>
            SendAsync(HttpMethod.Post, "/get-latest", "{\"path\":" + Ser(filePath) + "}");
    }
}
