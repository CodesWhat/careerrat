export function recordedKnowledgeChanges(messages = []) {
  const reverted = new Set(
    messages.flatMap((message) =>
      (message.artifacts || [])
        .filter((entry) => entry?.kind === "knowledge_write" && entry.revertOf)
        .map((entry) => `${entry.revertOf.messageId}:${entry.revertOf.index}`)
    )
  );
  return messages
    .flatMap((message) =>
      (message.artifacts || []).flatMap((entry, index) =>
        entry?.kind === "knowledge_write" && !entry.revertOf
          ? [
              {
                messageId: message.id,
                index,
                at: message.createdAt,
                entry,
                reverted: reverted.has(`${message.id}:${index}`),
              },
            ]
          : []
      )
    )
    .reverse();
}
