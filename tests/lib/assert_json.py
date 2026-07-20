#!/usr/bin/env python3
import json
import sys


def fail(message):
    raise SystemExit(f"assert_json: {message}")


def reject_constant(value):
    fail(f"nonstandard JSON constant is forbidden: {value}")


def decode_token(token):
    result = []
    index = 0
    while index < len(token):
        character = token[index]
        if character != "~":
            result.append(character)
            index += 1
            continue
        if index + 1 >= len(token) or token[index + 1] not in ("0", "1"):
            fail(f"malformed JSON Pointer escape in {token!r}")
        result.append("~" if token[index + 1] == "0" else "/")
        index += 2
    return "".join(result)


def parse_pointer(pointer):
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        fail(f"JSON Pointer must be empty or start with '/': {pointer!r}")
    return [decode_token(token) for token in pointer[1:].split("/")]


def parse_index(token):
    if token == "-" or not token or not token.isascii() or not token.isdigit():
        fail(f"invalid array index token: {token!r}")
    if len(token) > 1 and token.startswith("0"):
        fail(f"noncanonical array index token: {token!r}")
    return int(token)


def resolve(document, tokens):
    value = document
    for token in tokens:
        if isinstance(value, dict):
            if token not in value:
                fail(f"missing JSON Pointer token: {token!r}")
            value = value[token]
        elif isinstance(value, list):
            index = parse_index(token)
            if index >= len(value):
                fail(f"array index out of range: {index}")
            value = value[index]
        else:
            fail(f"cannot traverse {type(value).__name__} with token {token!r}")
    return value


def json_equal(actual, expected):
    if isinstance(actual, bool) or isinstance(expected, bool):
        return type(actual) is type(expected) and actual == expected
    if actual is None or expected is None:
        return actual is expected
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        return actual == expected
    if type(actual) is not type(expected):
        return False
    if isinstance(actual, list):
        return len(actual) == len(expected) and all(
            json_equal(left, right) for left, right in zip(actual, expected)
        )
    if isinstance(actual, dict):
        return actual.keys() == expected.keys() and all(
            json_equal(actual[key], expected[key]) for key in actual
        )
    return actual == expected


def load_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle, parse_constant=reject_constant)
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        fail(f"cannot load {path}: {exc}")


def parse_expected(source):
    try:
        return json.loads(source, parse_constant=reject_constant)
    except (json.JSONDecodeError, RecursionError) as exc:
        fail(f"EXPECTED_JSON is invalid: {exc}")


def main(argv):
    if len(argv) < 4:
        fail("usage: assert_json {equal|absent|contains} FILE POINTER [EXPECTED_JSON]")
    command, path, pointer = argv[1:4]
    document = load_json(path)
    tokens = parse_pointer(pointer)

    if command == "equal":
        if len(argv) != 5:
            fail("equal requires FILE POINTER EXPECTED_JSON")
        actual = resolve(document, tokens)
        expected = parse_expected(argv[4])
        if not json_equal(actual, expected):
            fail(f"{pointer!r} was {actual!r}, expected {expected!r}")
        return

    if command == "contains":
        if len(argv) != 5:
            fail("contains requires FILE POINTER EXPECTED_JSON")
        actual = resolve(document, tokens)
        if not isinstance(actual, list):
            fail(f"{pointer!r} must resolve to an array")
        expected = parse_expected(argv[4])
        if not any(json_equal(member, expected) for member in actual):
            fail(f"{pointer!r} does not contain {expected!r}")
        return

    if command == "absent":
        if len(argv) != 4:
            fail("absent requires FILE POINTER")
        if not tokens:
            fail("absent cannot target the document root")
        parent = resolve(document, tokens[:-1])
        final = tokens[-1]
        if isinstance(parent, dict):
            if final in parent:
                fail(f"{pointer!r} is present")
            return
        if isinstance(parent, list):
            index = parse_index(final)
            if index < len(parent):
                fail(f"{pointer!r} is present")
            return
        fail(f"parent of {pointer!r} must resolve to an object or array")

    fail(f"unknown command: {command}")


if __name__ == "__main__":
    main(sys.argv)
