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
