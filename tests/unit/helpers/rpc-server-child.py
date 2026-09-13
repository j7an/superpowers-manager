import json
import sys

scenario = sys.argv[1]


def emit(value: bytes) -> None:
    sys.stdout.buffer.write(value)
    sys.stdout.buffer.flush()


if scenario == "missing-initialization":
    sys.stdin.readline()
    raise SystemExit(0)

initialize = json.loads(sys.stdin.readline())
assert initialize["id"] == 0 and initialize["method"] == "initialize"
emit(b'{"id":0,"result":{}}\n')
initialized = json.loads(sys.stdin.readline())
assert initialized == {"method": "initialized"}
request = json.loads(sys.stdin.readline())
assert request["id"] == 1
assert request["method"] in ("hooks/list", "skills/list")
assert len(request["params"]["cwds"]) == 1
if request["method"] == "skills/list":
    assert request["params"]["forceReload"] is True

if scenario == "malformed-json":
    emit(b"{\n")
elif scenario == "invalid-utf8":
    emit(b"\xff\n")
elif scenario == "nan":
    emit(b'{"id":1,"result":NaN}\n')
elif scenario == "non-object":
    emit(b"[]\n")
elif scenario == "rpc-error":
    emit(b'{"id":1,"error":{"code":1}}\n')
elif scenario == "no-result":
    emit(b'{"id":1}\n')
elif scenario == "wrong-ids":
    emit(b'{"method":"notice"}\n{"id":true,"result":{"data":["wrong"]}}\n{"id":2,"result":{"data":["wrong"]}}\n{"id":1,"result":{"data":[]}}\n')
elif scenario == "eof":
    raise SystemExit(0)
elif scenario == "timeout":
    sys.stdin.read()
elif scenario in ("hooks-success", "skills-success"):
    emit(b'{"id":1,"result":{"data":[]}}\n')
else:
    raise SystemExit(f"unknown scenario: {scenario}")

sys.stdin.read()
