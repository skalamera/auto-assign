# API Key Setup

To hardcode your API key:

1. Take your Freshdesk API key
2. Append `:X` to it (e.g., `5TMgbcZdRFY70hSpEdj:X`)
3. Base64 encode the result
4. Replace `BASE64_ENCODED_API_KEY_X` in `config/requests.json` with the encoded value

Example:
- API Key: `abcd1234`
- With :X: `abcd1234:X`
- Base64: `YWJjZDEyMzQ6WA==`
- Final Authorization header: `"Authorization": "Basic YWJjZDEyMzQ6WA=="`

Or use this PowerShell command:
```powershell
[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("5TMgbcZdRFY70hSpEdj:X"))
```