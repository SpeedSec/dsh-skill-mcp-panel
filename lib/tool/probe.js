/** One bounded subprocess-adapter test run without registering a model tool. */
import { subprocessToolInputSchema } from "./model.js";
export async function probeSubprocessTool(ctx, rawInput, target) {
    let input;
    try {
        input = subprocessToolInputSchema.parse(rawInput);
    }
    catch (error) {
        return { ok: false, target, exitCode: null, stdout: "", stderr: "", error: "配置无效：" + (error instanceof Error ? error.message : String(error)) };
    }
    if (target.trim() === "")
        return { ok: false, target, exitCode: null, stdout: "", stderr: "", error: "测试 target 不能为空" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
        const handle = ctx.subprocess.spawn({
            argv: [input.command, ...input.args, target],
            cwd: process.cwd(),
            stdio: { stdin: "ignore", stdout: { maxBytes: input.outputMaxBytes }, stderr: { maxBytes: input.outputMaxBytes } },
            graceMs: input.graceMs,
            signal: controller.signal
        });
        const outcome = await handle.done;
        const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
        const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
        if (outcome.exitCode === null) {
            return { ok: false, target, exitCode: null, stdout, stderr, error: controller.signal.aborted ? "测试超时" : `进程被 ${outcome.signal ?? "未知信号"} 终止` };
        }
        const failedByOutput = input.failureText.some((text) => stdout.includes(text) || stderr.includes(text));
        return { ok: outcome.exitCode === 0 && !failedByOutput, target, exitCode: outcome.exitCode, stdout, stderr, ...(failedByOutput ? { error: "输出命中失败标记" } : {}) };
    }
    catch (error) {
        return { ok: false, target, exitCode: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
    }
    finally {
        clearTimeout(timer);
    }
}
