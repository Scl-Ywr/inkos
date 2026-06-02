import { create } from "zustand";
import type { ChatStore } from "./types";
import { initialChatState } from "./initialState";
import { createMessageSlice } from "./slices/message/action";
import { createCreateSlice } from "./slices/create/action";
import { loadPersistedMessageState, persistMessageState } from "./persistence";

export const useChatStore = create<ChatStore>()((...a) => ({
  ...initialChatState,
  ...loadPersistedMessageState(),
  ...createMessageSlice(...a),
  ...createCreateSlice(...a),
}));

useChatStore.subscribe((state) => {
  persistMessageState({
    sessions: state.sessions,
    sessionIdsByBook: state.sessionIdsByBook,
    activeSessionId: state.activeSessionId,
    input: state.input,
    selectedModel: state.selectedModel,
    selectedService: state.selectedService,
  });
});
