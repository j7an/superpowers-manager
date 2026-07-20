spw_test_root() {
  root=$(CDPATH= cd -- "$test_dir/.." && pwd)
}

spw_test_tmpdir() {
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' EXIT INT TERM
}

spw_assert_json() {
  python3 -S "$root/tests/lib/assert_json.py" "$@"
}

spw_git_commit() {
  _repo=$1
  _message=$2
  git -C "$_repo" \
    -c user.email=superpowers-manager@example.invalid \
    -c user.name=superpowers-manager \
    -c commit.gpgsign=false \
    commit -m "$_message" >/dev/null
}

spw_git_tag() {
  _repo=$1
  _tag=$2
  _message=$3
  git -C "$_repo" \
    -c user.email=superpowers-manager@example.invalid \
    -c user.name=superpowers-manager \
    -c tag.gpgsign=false \
    tag -a "$_tag" -m "$_message"
}

spw_section() {
  _name=$1
  shift
  set +e
  ( set -eu; "$@" )
  _status=$?
  set -e
  if [ "$_status" -ne 0 ]; then
    echo "section failed: $_name" >&2
    failed=$((failed + 1))
  fi
}
