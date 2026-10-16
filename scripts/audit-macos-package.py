"""Limited startup/native dependency audit of an unchanged published macOS app.

Does not grant macOS permissions, send input, access microphones/cameras, or
contact AI providers. A pass is NOT a full feature certification.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

app = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)
exe = app / "Contents/MacOS/ZVYRA"
resources = app / "Contents/Resources"
results = {"architecture": os.uname().machine, "nativeModules": {}}
errors = []
for module in ["sherpa-onnx-node", "@nut-tree-fork/libnut-darwin"]:
    script = (
        "const {createRequire}=require('node:module');"
        f"const req=createRequire({json.dumps(str(resources / 'app.asar/package.json'))});"
        f"const m=req({json.dumps(module)});"
        "console.log('AUDIT_MODULE_LOADED',Object.keys(m).slice(0,12));"
    )
    try:
        check = subprocess.run([str(exe), "-e", script], env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"}, capture_output=True, text=True, timeout=30)
        results["nativeModules"][module] = {"exitCode": check.returncode, "stdout": check.stdout, "stderr": check.stderr}
        if check.returncode != 0:
            errors.append(f"Native module failed to load: {module}")
    except subprocess.TimeoutExpired:
        results["nativeModules"][module] = {"timeout": True}
        errors.append(f"Native module load timed out: {module}")

with (output / "startup.log").open("w") as log:
    proc = subprocess.Popen([str(exe)], stdout=log, stderr=subprocess.STDOUT)
    time.sleep(25)
    results["survived25Seconds"] = proc.poll() is None
    if proc.poll() is not None:
        results["earlyExitCode"] = proc.returncode
        errors.append("App exited during the startup observation window")
    subprocess.run(["screencapture", "-x", str(output / "desktop.png")], timeout=15, check=False)
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)

logs = []
for folder in ["ZVYRA", "zvyra"]:
    directory = Path.home() / "Library/Application Support" / folder / "logs"
    if directory.exists():
        for entry in directory.glob("*.log"):
            text = entry.read_text(errors="replace")
            logs.append(text)
            (output / entry.name).write_text(text)
startup = (output / "startup.log").read_text(errors="replace")
all_logs = startup + "\n" + "\n".join(logs)
results["backendFallbackDetected"] = any(text in all_logs for text in ["Backend failed to start", "Running with the preview backend"])
if results["backendFallbackDetected"]:
    errors.append("Real backend failed; app fell back to the preview backend")
results["limits"] = "No AI key, physical microphone/camera, permission grants, or end-to-end feature tests. Startup survival alone does not prove a working UI."
results["errors"] = errors
(output / "report.json").write_text(json.dumps(results, indent=2))
print(json.dumps(results, indent=2))
sys.exit(1 if errors else 0)
