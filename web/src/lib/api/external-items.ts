import { request } from "./client";

export const externalItems = {
  like: (itemId: string, linkedAccountId: string) =>
    request<{ status: string }>(`/external-items/${itemId}/like`, {
      method: "POST",
      body: JSON.stringify({ linkedAccountId }),
    }),
  repost: (itemId: string, linkedAccountId: string) =>
    request<{ status: string }>(`/external-items/${itemId}/repost`, {
      method: "POST",
      body: JSON.stringify({ linkedAccountId }),
    }),
};
