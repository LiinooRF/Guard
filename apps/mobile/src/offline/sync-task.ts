import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { sincronizarCola } from './sync-queue';

const TASK_NAME = 'voxia-sync-queue-v1';

if (!TaskManager.isTaskDefined(TASK_NAME)) {
  TaskManager.defineTask(TASK_NAME, async () => {
    try {
      await sincronizarCola();
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function registrarSincronizacionBackground(): Promise<boolean> {
  if (!await TaskManager.isAvailableAsync()) return false;
  if (await TaskManager.isTaskRegisteredAsync(TASK_NAME)) return true;
  await BackgroundTask.registerTaskAsync(TASK_NAME, { minimumInterval: 15 });
  return true;
}
