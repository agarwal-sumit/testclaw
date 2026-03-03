import { execa } from "execa";
import { join } from "path";
import type { SimulatorDevice } from "./types.ts";
import { log } from "./utils/logger.ts";

export async function listDevices(): Promise<SimulatorDevice[]> {
  const { stdout } = await execa("xcrun", ["simctl", "list", "devices", "--json"]);
  const data = JSON.parse(stdout);
  const devices: SimulatorDevice[] = [];

  for (const [runtime, deviceList] of Object.entries(data.devices) as [string, any[]][]) {
    for (const device of deviceList) {
      if (device.isAvailable) {
        devices.push({
          udid: device.udid,
          name: device.name,
          state: device.state,
          runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", ""),
        });
      }
    }
  }

  return devices;
}

export async function getBootedDevice(): Promise<SimulatorDevice | null> {
  const devices = await listDevices();
  return devices.find((d) => d.state === "Booted") ?? null;
}

export async function bootDevice(udid: string): Promise<void> {
  log.info(`Booting simulator ${udid}`);
  try {
    await execa("xcrun", ["simctl", "boot", udid]);
  } catch (err: any) {
    if (err.stderr?.includes("current state: Booted")) {
      log.debug("Simulator already booted");
      return;
    }
    throw err;
  }
  // Open Simulator.app for visual feedback
  await execa("open", ["-a", "Simulator"]);
}

export async function shutdownDevice(udid: string): Promise<void> {
  log.info(`Shutting down simulator ${udid}`);
  try {
    await execa("xcrun", ["simctl", "shutdown", udid]);
  } catch (err: any) {
    if (err.stderr?.includes("current state: Shutdown")) {
      log.debug("Simulator already shut down");
      return;
    }
    throw err;
  }
}

export async function installApp(udid: string, appPath: string): Promise<void> {
  log.info(`Installing app on ${udid}`);
  await execa("xcrun", ["simctl", "install", udid, appPath]);
  log.success("App installed");
}

export async function launchApp(udid: string, bundleId: string): Promise<void> {
  log.info(`Launching ${bundleId} on ${udid}`);
  await execa("xcrun", ["simctl", "launch", udid, bundleId]);
}

export async function terminateApp(udid: string, bundleId: string): Promise<void> {
  try {
    await execa("xcrun", ["simctl", "terminate", udid, bundleId]);
  } catch {
    // App may not be running
  }
}

export async function takeScreenshot(udid: string, outputPath: string): Promise<string> {
  await execa("xcrun", ["simctl", "io", udid, "screenshot", outputPath]);
  return outputPath;
}

export async function startRecording(
  udid: string,
  outputPath: string
): Promise<{ stop: () => Promise<void> }> {
  const proc = execa("xcrun", ["simctl", "io", udid, "recordVideo", outputPath]);

  return {
    stop: async () => {
      proc.kill("SIGINT");
      try {
        await proc;
      } catch {
        // Expected SIGINT
      }
    },
  };
}

export async function findBestDevice(): Promise<SimulatorDevice> {
  const devices = await listDevices();

  // Prefer already-booted device
  const booted = devices.find((d) => d.state === "Booted");
  if (booted) return booted;

  // Prefer iPhone 16 Pro, then any iPhone
  const preferred = devices.find((d) => d.name.includes("iPhone 16 Pro"));
  if (preferred) return preferred;

  const anyIphone = devices.find((d) => d.name.includes("iPhone"));
  if (anyIphone) return anyIphone;

  if (devices.length === 0) {
    throw new Error("No iOS simulators available. Install via Xcode.");
  }

  return devices[0];
}

export async function eraseDevice(udid: string): Promise<void> {
  await execa("xcrun", ["simctl", "erase", udid]);
}

export async function getAppContainer(
  udid: string,
  bundleId: string
): Promise<string | null> {
  try {
    const { stdout } = await execa("xcrun", [
      "simctl",
      "get_app_container",
      udid,
      bundleId,
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}
