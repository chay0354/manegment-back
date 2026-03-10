# Fix: git push "Failed to connect to github.com port 443"

If you see:
```text
fatal: unable to access 'https://github.com/...': Failed to connect to github.com port 443
```

Try these in order.

---

## 1. Use SSH instead of HTTPS (port 22)

HTTPS uses port 443; SSH uses port 22. If only 443 is blocked, SSH can work.

**One-time: add GitHub to known hosts**
```powershell
ssh-keyscan -t rsa,ecdsa,ed25519 github.com >> $env:USERPROFILE\.ssh\known_hosts
```

**Ensure you have an SSH key and it’s added to GitHub:**  
https://docs.github.com/en/authentication/connecting-to-github-with-ssh

**Switch this repo to SSH and push**
```powershell
cd C:\projects\matriya\maneger-back
git remote set-url origin git@github.com:chay0354/manegment-back.git
git push origin main
```

To switch back to HTTPS later:
```powershell
git remote set-url origin https://github.com/chay0354/manegment-back.git
```

---

## 2. If you use a proxy

```powershell
git config --global http.proxy http://proxy.company.com:8080
git config --global https.proxy http://proxy.company.com:8080
```

(Replace with your proxy URL. Use `--global` only if you want it for all repos.)

---

## 3. Check connectivity

```powershell
Test-NetConnection github.com -Port 443
Test-NetConnection github.com -Port 22
```

If 443 fails and 22 works, use SSH (step 1). If both fail, it’s a firewall/VPN/network issue.

---

## 4. Longer timeout (slow networks)

```powershell
git config --global http.postBuffer 524288000
git config --global http.lowSpeedLimit 0
git config --global http.lowSpeedTime 999999
```

Then try `git push origin main` again.

---

## 5. SSH "unsupported KEX method" on Windows

If you use SSH and see `choose_kex: unsupported KEX method sntrup761x25519-sha512@openssh.com`, your OpenSSH is older than GitHub’s. Options:

- **Update Git for Windows** (includes OpenSSH): https://git-scm.com/download/win  
- Or stick with **HTTPS** and fix 443 (proxy, firewall, or other network).

---

## 6. Quick test: other network

Try the same `git push origin main` from another network (e.g. phone hotspot). If it works there, the problem is your usual network or firewall blocking port 443 (or 22 for SSH).
