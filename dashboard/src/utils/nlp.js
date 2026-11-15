const CRITICAL_CMDS = new Set([
  "away_arm",
  "away_disarm",
  "safety_clear",
  "privacy",
  "pad_fault",
  "alert_test",
  "all_off",
  "emergency_stop",
]);

export function needsConfirmation(cmd, arg = "") {
  if (cmd === "privacy") return true;
  return CRITICAL_CMDS.has(cmd);
}

const ROOM_WORDS = [
  ["living", "Living Room"],
  ["bed", "Bedroom"],
  ["kitchen", "Kitchen"],
  ["office", "Office"],
];

function detectRoom(text) {
  for (const [word, room] of ROOM_WORDS) {
    if (text.includes(word)) return room;
  }
  return null;
}

export function parseStructuredIntent(rawText) {
  const text = String(rawText || "").trim().toLowerCase();
  if (!text) return null;

  const isOff = /\b(off|disable|stop|close|shut|cut)\b/.test(text);
  const isOn = /\b(on|enable|start|open|activate)\b/.test(text);
  const pctMatch = text.match(/\b(\d{1,3})\s*%?/);
  const isQuestion =
    /^(why|what|how|when|show|tell|explain|summarize)\b/.test(text) ||
    /\b(status|summary|energy report|why did)\b/.test(text);

  if (isQuestion) {
    return { kind: "query", summary: "Summarize live wattage, alerts, and safety mode" };
  }

  let intent = null;

  if (/\b(emergency|panic)\b.*\b(stop|shutdown|cutoff|off)\b|\bemergency shutdown\b/.test(text)) {
    intent = {
      cmd: "emergency_stop",
      arg: "",
      label: "Emergency Home Shutdown & MCU Safety Latch",
    };
  } else if (/\benergy[\s-]*sav(er|ing)\b|\bsave energy\b/.test(text)) {
    intent = {
      cmd: "energy_saver",
      arg: "",
      label: "Energy Saver (AC eco 26C, lights capped at 40%, standby plugs off)",
    };
  } else if (
    /\b(all off|everything off|turn off everything|shut down all)\b/.test(text) ||
    (/\b(turn off|switch off|shut off)\s+all\b/.test(text) && !/\blights?\b/.test(text))
  ) {
    intent = {
      cmd: "all_off",
      arg: "",
      label: "Turn Off All Non-Critical Home Devices",
    };
  } else if (/\ball\b.*\blights?\b/.test(text) && isOff) {
    intent = { cmd: "lights_off", arg: "", label: "Turn off every light (not other devices)" };
  } else if (/\b(night mode|sleep mode|bedtime)\b/.test(text)) {
    intent = {
      cmd: "night_mode",
      arg: "",
      label: "Activate Night Comfort Mode (Eco 25C + Bed Lamp)",
    };
  } else if (/\b(away|vacation|arm|disarm)\b/.test(text)) {
    const disarm = /\b(disarm|home|off|cancel)\b/.test(text);
    intent = {
      cmd: disarm ? "away_disarm" : "away_arm",
      arg: "",
      label: disarm ? "Disarm Away Mode & unlock controls" : "Arm Away Security Mode",
    };
  } else if (/\b(clear|reset)\b.*\b(safety|alert|alarm|emergency)\b/.test(text)) {
    intent = { cmd: "safety_clear", arg: "", label: "Clear latched safety emergency override" };
  } else if (/\bprivacy\b/.test(text)) {
    const off = isOff && !/\bon\b/.test(text);
    intent = {
      cmd: "privacy",
      arg: off ? "off" : "on",
      label: off ? "Disable Privacy Curtain" : "Enable Hardware Privacy Curtain",
    };
  } else if (/\beco\b/.test(text)) {
    const off = isOff && !/\bon\b/.test(text);
    intent = {
      cmd: "eco",
      arg: off ? "off" : "on",
      label: off ? "Disable Auto-Eco" : "Enable Auto-Eco Optimization",
    };
  } else if (/\b(kettle|kitchen plug)\b/.test(text)) {
    intent = {
      cmd: "plug_kettle",
      arg: isOff ? "off" : "on",
      label: `${isOff ? "Turn off" : "Turn on"} Induction Kettle Plug`,
    };
  } else if (/\b(tv|television)\b/.test(text)) {
    intent = {
      cmd: "plug_tv",
      arg: isOff ? "off" : "on",
      label: `${isOff ? "Turn off" : "Turn on"} OLED TV Smart Plug`,
    };
  } else if (/\b(desk plug|workstation|office plug)\b/.test(text)) {
    intent = {
      cmd: "plug_desk",
      arg: isOff ? "off" : "on",
      label: `${isOff ? "Turn off" : "Turn on"} Office Workstation Dock Plug`,
    };
  } else if (/\b(floor lamp|living lamp)\b/.test(text)) {
    intent = {
      cmd: "lamp_living",
      arg: isOff ? "off" : "on",
      label: `${isOff ? "Turn off" : "Turn on"} Floor Ambient Lamp`,
    };
  } else if (/\b(bed lamp|bedside)\b/.test(text)) {
    intent = {
      cmd: "lamp_bed",
      arg: isOff ? "off" : "on",
      label: `${isOff ? "Turn off" : "Turn on"} Bedside Warm Lamp`,
    };
  } else if (/\b(wireless|pad|charger|coil|electrawireless)\b/.test(text)) {
    if (/\b(fault|overheat|thermal)\b/.test(text)) {
      intent = {
        cmd: "pad_fault",
        arg: isOff ? "off" : "on",
        label: `${isOff ? "Clear" : "Inject"} ElectraWireless Thermal Fault`,
      };
    } else {
      intent = {
        cmd: "pad_tx",
        arg: isOff ? "off" : "on",
        label: `${isOff ? "Disable" : "Enable"} ElectraWireless Pad`,
      };
    }
  } else if (/\b(ac|air\s*conditioner|cooling)\b/.test(text)) {
    const room = detectRoom(text);
    if (room && room !== "Bedroom") {
      return { kind: "unsupported", message: `The only AC in this setup is in the Bedroom, not the ${room}.` };
    }
    const tempMatch = text.match(/\b(1[6-9]|2[0-9]|30)\s*(?:c|deg|degree|degrees)?\b/);
    if (tempMatch && !isOff) {
      const targetC = Number(tempMatch[1]);
      intent = {
        cmd: "ac_config",
        arg: JSON.stringify({ on: true, targetC }),
        label: `Set Bedroom AC to ${targetC}C`,
      };
    } else {
      intent = { cmd: "ac", arg: isOff ? "off" : "on", label: `${isOff ? "Turn off" : "Turn on"} Bedroom AC` };
    }
  } else if (/\bfan\b/.test(text)) {
    intent = { cmd: "fan", arg: isOff ? "off" : "on", label: `${isOff ? "Turn off" : "Turn on"} Bedroom Ceiling Fan` };
  } else if (/\b(rgb|blue|green|red|purple|amber)\b/.test(text)) {
    let rgbArg = "0,80,100";
    if (text.includes("green")) rgbArg = "0,95,25";
    else if (text.includes("red")) rgbArg = "95,0,0";
    else if (text.includes("amber")) rgbArg = "95,40,0";
    else if (text.includes("purple")) rgbArg = "70,10,95";
    intent = { cmd: "rgb", arg: rgbArg, label: `Set Hub RGB PWM to ${rgbArg}` };
  } else if (/\b(light|lights|brightness|lamp|dim)\b/.test(text)) {
    const room = detectRoom(text);
    if (room === "Bedroom") {
      intent = {
        cmd: "lamp_bed",
        arg: isOff ? "off" : "on",
        label: `${isOff ? "Turn off" : "Turn on"} Bedside Warm Lamp`,
      };
    } else if (room === "Kitchen" || room === "Office") {
      return { kind: "unsupported", message: `There is no light in the ${room} in this setup.` };
    } else {
      let arg = isOff ? "off" : isOn ? "on" : "toggle";
      if (pctMatch && !isOff) {
        const pct = Math.min(100, Math.max(0, Number(pctMatch[1])));
        arg = String(pct);
      }
      intent = { cmd: "light", arg, label: `Set Living Room Hub Light to ${arg}` };
    }
  } else if (/\bcan\b/.test(text)) {
    intent = { cmd: "can_diag", arg: "", label: "Run CAN1 Loopback Diagnostic" };
  } else if (/\b(flash|jedec|audit)\b/.test(text)) {
    intent = { cmd: "flash_id", arg: "", label: "Verify W25Q64 Flash JEDEC ID" };
  } else if (/\b(thermal test|fall test|alert test)\b/.test(text)) {
    intent = {
      cmd: "alert_test",
      arg: text.includes("fall") ? "fall" : "thermal",
      label: "Trigger Safety Override Test",
    };
  }

  if (!intent) return null;
  return {
    kind: "command",
    ...intent,
    requiresConfirmation: needsConfirmation(intent.cmd, intent.arg),
    source: "offline-nlp",
  };
}

/* The LLM runs on the gateway (key never reaches the browser). Its answer is only a suggestion. */
export function intentFromLlm(result) {
  if (!result?.ok || !result.intent) return null;
  const { cmd, arg, label } = result.intent;
  return {
    kind: "command",
    cmd,
    arg,
    label,
    requiresConfirmation: needsConfirmation(cmd, arg),
    source: "llm",
  };
}
