"""Read-only OSV scan of public Cargo.lock packages; sends names/versions only."""
import concurrent.futures
import json
import pathlib
import subprocess
import tomllib

root = pathlib.Path(__file__).resolve().parents[4]
packages = [
    {"package": {"name": p["name"], "ecosystem": "crates.io"}, "version": p["version"]}
    for p in tomllib.loads((root / "src-tauri/Cargo.lock").read_text())["package"]
    if p.get("source", "").startswith("registry+")
]
results = []
def request_json(url, payload=None):
    command = ["curl", "--fail", "--silent", "--show-error", "--max-time", "45"]
    if payload is not None:
        command += ["-H", "Content-Type: application/json", "--data-binary", "@-"]
    result = subprocess.run(command + [url], input=payload, capture_output=True, check=True)
    return json.loads(result.stdout)

for offset in range(0, len(packages), 100):
    batch = packages[offset:offset + 100]
    answers = request_json(
        "https://api.osv.dev/v1/querybatch",
        json.dumps({"queries": batch}).encode(),
    )["results"]
    results.extend({**package, **answer} for package, answer in zip(batch, answers) if answer.get("vulns"))

def detail(vulnerability_id):
    return request_json("https://api.osv.dev/v1/vulns/" + vulnerability_id)

ids = sorted({v["id"] for result in results for v in result["vulns"]})
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
    details = list(executor.map(detail, ids))
output = {"packageCount": len(packages), "matches": results, "advisories": details}
pathlib.Path("/tmp/opus-audit-20260909/cargo-osv.json").write_text(json.dumps(output, indent=2))
print(json.dumps({"packageCount": len(packages), "matches": results}, indent=2))
