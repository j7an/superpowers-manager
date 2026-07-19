spw_test_root() {
  root=$(CDPATH= cd -- "$test_dir/.." && pwd)
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
