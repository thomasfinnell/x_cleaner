# Extension signing keys

Put your Chrome pack/signing `.pem` file in this folder (gitignored).

Example:

```text
keys/x_cleaner.pem
```

Pack from the repo root (adjust paths to your Chrome install):

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  --pack-extension="$PWD" `
  --pack-extension-key="$PWD\keys\x_cleaner.pem"
```

The first pack creates the `.pem`; reuse the same key for updates so the extension ID stays stable.