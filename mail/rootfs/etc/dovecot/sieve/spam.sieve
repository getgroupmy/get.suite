require ["fileinto"];
# Rspamd marks likely spam with "X-Spam: Yes"; file it into Junk.
if header :is "X-Spam" "Yes" {
  fileinto "Junk";
  stop;
}
