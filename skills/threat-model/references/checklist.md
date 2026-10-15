# Attack classes, and how to demonstrate each

| Class | Look for | Demonstration |
| --- | --- | --- |
| Authentication | New routes without the auth middleware; tokens accepted without signature or expiry checks | A request without credentials, or with an expired or altered token, that succeeds |
| Authorization (object level) | Lookups by an ID from the request without an owner check | User A reading or changing user B's record by its ID |
| SQL injection | Queries built with string concatenation or template strings | Input `' OR '1'='1` or `1; DROP …` changing the result |
| Command injection | `exec` or `system` with a string; `shell=True` | Input `; touch /tmp/pwned` creating the file in the sandbox |
| Path traversal | File paths joined from user input | `../../etc/passwd` or an absolute path escaping the base directory |
| XSS / HTML injection | `innerHTML`, `dangerouslySetInnerHTML`, unescaped templates | `<img src=x onerror=…>` rendered as markup |
| SSRF | Server-side fetch of a user-supplied URL | `http://127.0.0.1:…` or a metadata IP being fetched |
| Open redirect | Redirect to a `next` or `url` parameter | `?next=https://evil.example` followed off-site |
| Deserialization | `pickle`, `yaml.load`, `eval`, or `Function` on input | Crafted payload executing code |
| Secrets exposure | Secrets in logs, errors, client bundles or URLs | The secret visible in output a user can see |
| Race on a check | Check-then-act on balances, quotas or ownership | Two concurrent requests both passing the check |
| Resource exhaustion | Unbounded loops, uploads, regexes or pagination | A large or crafted input that hangs or exhausts memory |
| CSRF / CORS | State-changing GET; `Access-Control-Allow-Origin: *` with credentials | A cross-origin request that changes state |
