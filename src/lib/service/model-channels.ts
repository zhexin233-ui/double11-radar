import type Database from "better-sqlite3";
import {
  listModelChannels,
  getModelChannel,
  getActiveModelChannel,
  createModelChannel,
  updateModelChannel,
  deleteModelChannel,
  setActiveModelChannel,
  type CreateModelChannelInput,
  type UpdateModelChannelInput,
} from "@/lib/db/repos/model-channels";
import { saveJevConfig } from "@/lib/service/config";
import type { ModelChannel } from "@/lib/domain/types";

export function getChannels(db: Database.Database): ModelChannel[] {
  return listModelChannels(db);
}

export function addChannel(
  db: Database.Database,
  input: CreateModelChannelInput,
): ModelChannel {
  const channel = createModelChannel(db, input);
  if (channel.isActive) {
    // 同步到 settings
    saveJevConfig(db, {
      baseUrl: channel.baseUrl,
      model: channel.model,
      timeoutMs: channel.timeoutMs,
    });
  }
  return channel;
}

export function editChannel(
  db: Database.Database,
  input: UpdateModelChannelInput,
): ModelChannel | null {
  const channel = updateModelChannel(db, input);
  if (channel && channel.isActive) {
    saveJevConfig(db, {
      baseUrl: channel.baseUrl,
      model: channel.model,
      timeoutMs: channel.timeoutMs,
    });
  }
  return channel;
}

export function removeChannel(
  db: Database.Database,
  id: string,
): { deleted: boolean; reason?: string } {
  return deleteModelChannel(db, id);
}

export function activateChannel(
  db: Database.Database,
  id: string,
): ModelChannel | null {
  const channel = setActiveModelChannel(db, id);
  if (channel) {
    saveJevConfig(db, {
      baseUrl: channel.baseUrl,
      model: channel.model,
      timeoutMs: channel.timeoutMs,
    });
  }
  return channel;
}
