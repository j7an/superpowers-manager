# Semantic assertions for SHA-pinned workflow actions.

action_pin_pair() (
  _ap_block=$1
  _ap_target=$2

  printf '%s\n' "$_ap_block" | awk -v target="$_ap_target" '
    {
      line = $0
      sub(/^[[:space:]]*-[[:space:]]+uses:[[:space:]]*/, "", line)
      sub(/^[[:space:]]*uses:[[:space:]]*/, "", line)

      quote = substr(line, 1, 1)
      if (quote == "\"" || quote == "\047") {
        line = substr(line, 2)
      } else {
        quote = ""
      }

      if (index(line, target "@") != 1) {
        next
      }
      reference_count++

      separator = index(line, " # ")
      if (separator == 0) {
        next
      }

      ref = substr(line, 1, separator - 1)
      comment = substr(line, separator + 3)
      if (quote != "") {
        if (substr(ref, length(ref), 1) != quote) {
          next
        }
        ref = substr(ref, 1, length(ref) - 1)
      }

      sha = substr(ref, length(target) + 2)
      if (length(sha) == 40 && sha ~ /^[0-9a-f]+$/ && comment ~ /^v[0-9]+\.[0-9]+\.[0-9]+$/) {
        valid_count++
        pair = sha "\t" comment
      }
    }
    END {
      if (reference_count != 1 || valid_count != 1) {
        printf \
          "expected exactly one semantic action pin for %s; found %d references and %d valid pins\n", \
          target, reference_count + 0, valid_count + 0 > "/dev/stderr"
        exit 1
      }
      print pair
    }
  '
)

assert_action_pin() {
  action_pin_pair "$1" "$2" >/dev/null
}

find_literal_action_pin_snapshots() {
  awk '
    {
      remaining = $0
      while (match(remaining, /[[:alnum:]_.-]+\/[[:alnum:]_.\/-]+@[0-9A-Fa-f]+/)) {
        candidate = substr(remaining, RSTART, RLENGTH)
        suffix = substr(remaining, RSTART + RLENGTH)
        sha = substr(candidate, index(candidate, "@") + 1)
        delimiter = substr(suffix, 1, 1)
        if (length(sha) == 40 && (delimiter == "" || delimiter ~ /[[:space:][:punct:]]/)) {
          printf "%s:%d:%s\n", FILENAME, FNR, $0
          next
        }
        remaining = suffix
      }
    }
  ' "$@"
}
