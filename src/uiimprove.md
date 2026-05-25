# VaultKey UI Fix Workflow

## 1. Replace Export Text with Icons
- Remove `Export` text from 3-dots menu
- Use icon-only menu:
  - ⬆ Export
  - 🗑 Delete
- Keep menu compact and minimal

---

## 2. Add Delete Action in Same Menu
Order:
```text
⬆ Export
🗑 Delete
```

Guidelines:
- Delete icon in red
- Add confirmation modal before delete

---

## 3. Make Profile Box Smaller
Reduce:
- avatar size
- vertical padding
- spacing between title/subtitle

Goal:
- compact header
- less empty space
- cleaner unlock section

---

## 4. Improve “+ New Vault” & “Import”
Current text links feel outdated.

## Recommended Modern Style
Use small icon buttons:

```text
[ + ]  [ ⬆ ]
```

With:
- tooltip on hover
- soft outlined buttons
- 36–40px square size

Icons:
- `+` → New vault
- `⬆` → Import vault

This matches:
- Windsurf
- Cursor
- Codex
- modern AI IDEs

---

# Final UI Direction
- Minimal
- Icon-first
- Compact spacing
- One primary CTA only:
  `Unlock Vault`