# State Management
- Always use ID-based state for selections (e.g., `selectedId`) and derive the object from the list (`transcripts.find(...)`). This prevents stale data issues between Firestore listeners and UI selection state.
- Perform optimistic updates for both the list and the selection state during uploads to ensure immediate UI feedback.
