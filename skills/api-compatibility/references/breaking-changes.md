# Breaking or not?

| Change | Breaking? |
| --- | --- |
| Remove or rename an export, route, field, flag or event | Yes |
| Add an optional parameter or field | No, if old callers send nothing and get the old behavior |
| Add a required parameter or field | Yes |
| Change a parameter's type, unit or order | Yes |
| Accept less (stricter validation) | Yes, for callers sending the now-rejected input |
| Accept more | Usually no |
| Return more fields | Usually no; yes for strict schema validators |
| Return a new enum value | Yes, for exhaustive consumers |
| Change a default | Yes, behavior changes silently |
| Change error type, code or message format | Yes, for callers that branch on it |
| Change HTTP status codes | Yes |
| Change ordering of results | Yes, if documented or relied upon |
| Make something async that was sync, or the reverse | Yes |
| Change performance characteristics drastically | Possibly; say so |
