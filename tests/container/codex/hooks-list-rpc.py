from __future__ import annotations

import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time

cwd, response_name, stderr_name = sys.argv[1:]
deadline = time.monotonic() + 25
buffer = bytearray()


def fail(message: str) -> None:
    raise SystemExit(f"Codex hooks/list protocol failed: {message}")


def reject_constant(constant: str) -> None:
    raise ValueError(f"non-standard numeric constant: {constant}")


def send(process: subprocess.Popen[bytes], message: dict[str, object]) -> None:
    if process.poll() is not None or process.stdin is None:
        fail("app-server exited before request")
    try:
        payload = json.dumps(
            message, allow_nan=False, separators=(",", ":")
        ).encode("utf-8") + b"\n"
        process.stdin.write(payload)
        process.stdin.flush()
    except (BrokenPipeError, OSError) as exc:
        fail(f"could not send request: {exc}")


def next_message(
    process: subprocess.Popen[bytes],
    selector: selectors.BaseSelector,
) -> dict[str, object]:
    while True:
        newline = buffer.find(b"\n")
        if newline >= 0:
            raw = bytes(buffer[:newline])
            del buffer[: newline + 1]
            if not raw:
                continue
            try:
                message = json.loads(
                    raw.decode("utf-8"), parse_constant=reject_constant
                )
            except (UnicodeError, ValueError) as exc:
                fail(f"malformed JSONL response: {exc}")
            if not isinstance(message, dict):
                fail("JSONL response must be an object")
            return message

        remaining = deadline - time.monotonic()
        if remaining <= 0 or not selector.select(remaining):
            fail("timed out waiting for app-server output")
        if process.stdout is None:
            fail("app-server stdout is unavailable")
        chunk = os.read(process.stdout.fileno(), 65536)
        if not chunk:
            fail("EOF before the required response")
        buffer.extend(chunk)


def receive(
    process: subprocess.Popen[bytes],
    selector: selectors.BaseSelector,
    expected_id: int,
) -> dict[str, object]:
    while True:
        message = next_message(process, selector)
        id_value = message.get("id")
        if type(id_value) is not int or id_value != expected_id:
            continue
        if "error" in message:
            fail(f"RPC error for id {expected_id}: {message['error']!r}")
        if "result" not in message:
            fail(f"response id {expected_id} has no result")
        return message


stderr_path = Path(stderr_name)
with stderr_path.open("w", encoding="utf-8") as stderr_handle:
    process = subprocess.Popen(
        ["codex", "app-server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=stderr_handle,
        bufsize=0,
    )
    selector = selectors.DefaultSelector()
    if process.stdout is None:
        fail("app-server stdout pipe was not created")
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        send(
            process,
            {
                "id": 0,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "superpowers-manager-container-probe",
                        "version": "1",
                    }
                },
            },
        )
        receive(process, selector, 0)
        send(process, {"method": "initialized"})
        send(process, {"id": 1, "method": "hooks/list", "params": {"cwds": [cwd]}})
        response = receive(process, selector, 1)
        Path(response_name).write_text(
            json.dumps(response, allow_nan=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
    finally:
        selector.close()
        if process.stdin is not None:
            try:
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
