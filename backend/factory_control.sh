#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  厂区访客管控 — 通用版 ADB 管控脚本 v3
#  兼容：小米/MIUI、华为/HarmonyOS、三星/OneUI、OPPO/ColorOS、
#        vivo/OriginOS、荣耀、一加、摩托罗拉、索尼、原生 Android
#
#  用法：
#    chmod +x factory_control.sh
#    ./factory_control.sh apply    # 进厂：自动发现并下发管控
#    ./factory_control.sh remove   # 离厂：精确还原
#    ./factory_control.sh status   # 查看当前状态
#    ./factory_control.sh scan     # 仅扫描，不执行（调试用）
#
#  多设备时指定序列号：
#    ./factory_control.sh apply  adb-XXXX._adb-tls-connect._tcp
#    ./factory_control.sh remove adb-XXXX._adb-tls-connect._tcp
# ═══════════════════════════════════════════════════════════════


# ── 全局配置 ──────────────────────────────────────────────────
FACTORY_APP_PKG="com.factory.control"
SAVE_DIR="/data/local/tmp/factory_ctrl"

# 相机/录屏包名关键词（动态发现用）
CAMERA_KEYWORDS="camera|miuicamera|huaweicamera|seccamera|hihonorcamera"
RECORDER_KEYWORDS="screenrecord|screen.record|recorder|screenshot|screencap"
TILE_REMOVE_KEYWORDS="screenshot|screenrecord|recorder|screencap|capture"

# 撤销摄像头权限时跳过的包前缀（系统核心组件）
CAMERA_EXEMPT_PREFIXES=(
    "com.android.systemui"
    "com.android.phone"
    "com.android.contacts"
    "com.android.providers"
    "com.google.android.gms"
    "com.google.android.gsf"
    "android"
    "$FACTORY_APP_PKG"
)

# 强制额外处理的一组包名：
# - 不依赖 dumpsys 是否显示 CAMERA granted=true
# - 无论当前授权状态如何，都会在 apply 阶段额外执行一次撤销/恢复逻辑
FORCE_CAMERA_PKGS=(
    "com.tencent.mm"             # 微信
    "com.ss.android.ugc.aweme"   # 抖音
    "com.xunmeng.pinduoduo"      # 拼多多
    "com.xingin.xhs"             # 小红书
    "com.digitalgd.dgyss"        # 数字广东粤省事
    # 如需扩展更多强制管控 App，请在此追加包名，例如：
    # "com.eg.android.AlipayGphone"   # 支付宝
    # "com.taobao.taobao"             # 淘宝
)

# 兜底静态包名（pm 关键词过滤未命中时补充）
FALLBACK_CAMERA_PKGS=(
    "com.android.camera2" "com.android.camera"
    "com.sec.android.app.camera" "com.huawei.camera"
    "com.miui.camera" "com.miui.cameraserver"
    "com.oppo.camera" "com.vivo.camera"
    "com.oneplus.camera" "com.hihonor.camera"
    "com.motorola.camera2" "com.sonymobile.android.camera"
    "com.asus.camera" "com.google.android.GoogleCamera"
)
FALLBACK_RECORDER_PKGS=(
    "com.miui.screenrecorder" "com.sec.android.screenrecorder"
    "com.huawei.capture.recorder" "com.coloros.screenrecorder"
    "com.android.screenrecord" "com.hihonor.screenrecorder"
    "com.hihonor.HnMultiScreenShot" "com.vivo.screenshot"
    "com.asus.screenrecorder" "com.sonymobile.screenrecorder"
)

# ── 颜色输出 ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; GRAY='\033[0;37m'; NC='\033[0m'
log()   { echo -e "${CYAN}[INFO]${NC}  $1"; }
ok()    { echo -e "${GREEN}[ OK ]${NC}  $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
err()   { echo -e "${RED}[FAIL]${NC}  $1"; }
debug() { echo -e "${GRAY}[DBG ]${NC}  $1"; }

# ─────────────────────────────────────────────────────────────
#  工具：判断包名是否在豁免列表中
# ─────────────────────────────────────────────────────────────
is_exempt() {
    local pkg="$1"
    for prefix in "${CAMERA_EXEMPT_PREFIXES[@]}"; do
        case "$pkg" in
            "$prefix"|"${prefix}."*) return 0 ;;
        esac
    done
    return 1
}

# ─────────────────────────────────────────────────────────────
#  设备选择
# ─────────────────────────────────────────────────────────────
select_device() {
    local requested="${1:-}"
    if [ -n "$requested" ]; then
        ADB="adb -s $requested"
        if ! $ADB get-state >/dev/null 2>&1; then
            err "指定设备 $requested 不在线"; exit 1
        fi
        return
    fi

    local devices count
    devices=$(adb devices | grep -v "^List\|^$\|\*" | grep "device$" | awk '{print $1}')
    count=$(echo "$devices" | grep -c . 2>/dev/null || echo 0)

    if [ "$count" -eq 0 ]; then
        err "没有检测到已连接设备，请先完成 ADB 配对"
        err "运行: adb pair <手机IP>:<端口> <配对码>"; exit 1
    elif [ "$count" -eq 1 ]; then
        DEVICE_SERIAL="$devices"
        ADB="adb -s $DEVICE_SERIAL"
        debug "自动选择唯一设备：$DEVICE_SERIAL"
    else
        echo ""; log "检测到多台已连接设备，请选择："
        local i=1
        local device_list=()
        while IFS= read -r d; do
            local m brand
            m=$(adb -s "$d" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
            brand=$(adb -s "$d" shell getprop ro.product.brand 2>/dev/null | tr -d '\r')
            printf "  [%d] %s  (%s %s)\n" "$i" "$d" "$brand" "$m"
            device_list+=("$d"); ((i++))
        done <<< "$devices"
        echo ""; read -rp "输入编号 (1-$((i-1))): " choice
        DEVICE_SERIAL="${device_list[$((choice-1))]}"
        ADB="adb -s $DEVICE_SERIAL"
        log "已选择：$DEVICE_SERIAL"
    fi
}

# ─────────────────────────────────────────────────────────────
#  设备信息
# ─────────────────────────────────────────────────────────────
collect_device_info() {
    MODEL=$($ADB shell getprop ro.product.model 2>/dev/null | tr -d '\r')
    BRAND=$($ADB shell getprop ro.product.brand 2>/dev/null | tr -d '\r')
    ANDROID=$($ADB shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')
    SDK=$($ADB shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')
    ROM=$($ADB shell getprop ro.build.display.id 2>/dev/null | tr -d '\r')
    ok "设备：$BRAND $MODEL  Android $ANDROID (API $SDK)"
    debug "ROM：$ROM"
}

# ─────────────────────────────────────────────────────────────
#  动态发现：相机/录屏包（按包名关键词）
# ─────────────────────────────────────────────────────────────
discover_target_pkgs() {
    local keywords="$1"
    # -u 参数包含已禁用的包（pm disable-user 后从默认列表消失，status 检查时需要 -u 才能看到）
    $ADB shell pm list packages -u 2>/dev/null \
        | sed 's/package://' | tr -d '\r' \
        | grep -iE "$keywords" \
        | grep -v "^${FACTORY_APP_PKG}$" \
        || true
}

# ─────────────────────────────────────────────────────────────
#  发现所有已授权 CAMERA 权限的 App（方案 C + 自动降级保底）
# ─────────────────────────────────────────────────────────────
discover_camera_granted_pkgs() {
    # 方案 C：设备端 grep 预过滤 5MB → 约 20KB，Mac 端 awk 解析小数据
    local result
    result=$(
        $ADB shell "dumpsys package 2>/dev/null \
            | grep -E '^  Package \[|android\.permission\.CAMERA'" \
            | tr -d '\r' \
            | awk '
                /^  Package \[/ {
                    pkg = $0
                    sub(/.*\[/, "", pkg)
                    sub(/\].*/, "", pkg)
                }
                /android\.permission\.CAMERA/ && /granted=true/ {
                    if (pkg != "") print pkg
                }
            ' | sort -u | grep -v "^$" || true
    )

    # 自动降级保底：若方案 C 返回结果 ≤1 条，且设备包数量 > 50
    # 说明 grep 管道在当前设备仍被截断，改为全量逐包检查（较慢，约 30~90s）
    local line_count pkg_count
    line_count=$(echo "$result" | grep -c . 2>/dev/null || echo 0)
    pkg_count=$($ADB shell "pm list packages -u 2>/dev/null | wc -l" \
        | tr -d '\r\n[:space:]' | grep -o '[0-9]*' | head -1)
    if [ "${line_count}" -le 1 ] && [ "${pkg_count:-0}" -gt 50 ]; then
        debug "  [方案C截断，降级逐包扫描，共${pkg_count}个包，约需30~90秒]"
        result=$(
            $ADB shell pm list packages -u 2>/dev/null \
                | sed 's/package://' | tr -d '\r' | grep -v "^$" \
                | while IFS= read -r pkg; do
                    pkg=$(echo "$pkg" | tr -d ' ')
                    [ -z "$pkg" ] && continue
                    cnt=$($ADB shell "dumpsys package '$pkg' 2>/dev/null \
                        | grep 'android.permission.CAMERA' \
                        | grep -c 'granted=true'" 2>/dev/null \
                        | tr -d '\r\n[:space:]' | grep -o '[0-9]*' | head -1)
                    [ "${cnt:-0}" -gt 0 ] && echo "$pkg"
                done | sort -u
        )
    fi

    echo "$result"
}

# ─────────────────────────────────────────────────────────────
#  动态发现：控制中心截屏/录屏 Tile
# ─────────────────────────────────────────────────────────────
discover_screenshot_tiles() {
    local tiles
    tiles=$($ADB shell settings get secure sysui_qs_tiles 2>/dev/null | tr -d '\r')
    [ "$tiles" = "null" ] || [ -z "$tiles" ] && return
    echo "$tiles" | tr ',' '\n' | grep -iE "$TILE_REMOVE_KEYWORDS" || true
}

# ─────────────────────────────────────────────────────────────
#  设备端状态备份
# ─────────────────────────────────────────────────────────────
save_state() {
    local key="$1" value="$2"
    # BUG-3/4 FIX: 原来用 printf '%s' '${value}' 拼进远端 shell 命令字符串，
    #              当 value 含 ( ) ' 等特殊字符（如 tiles 里的 custom(pkg/class)）时
    #              远端 /bin/sh 报 "syntax error: unexpected '('"，文件写入静默失败。
    #              改为通过 stdin 管道传值，远端 shell 用 cat > file 接收，
    #              完全绕开 shell 引号/特殊字符问题。
    $ADB shell "mkdir -p $SAVE_DIR" >/dev/null 2>&1 || true
    printf '%s' "$value" | $ADB shell "cat > $SAVE_DIR/$key" 2>/dev/null || true
}

load_state() {
    local key="$1"
    # exec-out 不分配 PTY（不同于 shell），彻底避免 TTY 控制字节混入。
    # 这是乱码和 | 分隔符被破坏的根治方案，sed/tr 清理都是治标。
    # 语法：adb -s SERIAL exec-out "cmd" — 与 shell 完全兼容，Android 5+ 支持。
    local adb_bin adb_serial
    adb_bin=$(echo "$ADB" | awk '{print $1}')
    adb_serial=$(echo "$ADB" | awk '{print $3}')
    "$adb_bin" -s "$adb_serial" exec-out "cat $SAVE_DIR/$key 2>/dev/null" \
        2>/dev/null | tr -d '\r\n' | tr -cd '[:print:]' || true
}

clear_state() {
    $ADB shell "rm -rf $SAVE_DIR" >/dev/null 2>&1 || true
}

# ─────────────────────────────────────────────────────────────
#  撤销单个包的摄像头权限（四层叠加）
# ─────────────────────────────────────────────────────────────
revoke_camera_for_pkg() {
    local pkg="$1"
    # 层1：撤销运行时权限（对用户安装的 App 有效；系统 App 静默失败但不影响后续层）
    $ADB shell pm revoke "$pkg" android.permission.CAMERA >/dev/null 2>&1 || true
    # 层2：user-fixed 标志防止用户在设置中重新授权
    $ADB shell pm set-permission-flags "$pkg" android.permission.CAMERA user-fixed >/dev/null 2>&1 || true
    # 层3：appops 按包名拒绝（对运行时权限 App 有效）
    $ADB shell appops set "$pkg" CAMERA deny >/dev/null 2>&1 || true
    $ADB shell appops set "$pkg" PROJECT_MEDIA deny >/dev/null 2>&1 || true
    $ADB shell appops set "$pkg" TAKE_MEDIA_SCREENSHOTS deny >/dev/null 2>&1 || true
    # 层4：appops 按 UID 拒绝（对系统 App / system uid 进程有效，覆盖层3的盲区）
    local uid
    uid=$($ADB shell "dumpsys package '$pkg' 2>/dev/null | grep 'userId=' | head -1 | sed 's/.*userId=//;s/ .*//' " \
        | tr -d '\r\n[:space:]')
    if [ -n "$uid" ]; then
        $ADB shell appops set --uid "$uid" CAMERA deny >/dev/null 2>&1 || true
    fi
    # 强制停止进程使权限立即生效
    $ADB shell am force-stop "$pkg" >/dev/null 2>&1 || true
}

# 恢复单个包的摄像头权限（必须先清 user-fixed 再 grant）
restore_camera_for_pkg() {
    local pkg="$1"
    $ADB shell pm set-permission-flags "$pkg" android.permission.CAMERA 0 >/dev/null 2>&1 || true
    $ADB shell pm grant "$pkg" android.permission.CAMERA >/dev/null 2>&1 || true
    $ADB shell appops set "$pkg" CAMERA allow >/dev/null 2>&1 || true
    $ADB shell appops set "$pkg" PROJECT_MEDIA allow >/dev/null 2>&1 || true
    $ADB shell appops set "$pkg" TAKE_MEDIA_SCREENSHOTS allow >/dev/null 2>&1 || true
    # 同步恢复 UID 级别的 appops
    local uid
    uid=$($ADB shell "dumpsys package '$pkg' 2>/dev/null | grep 'userId=' | head -1 | sed 's/.*userId=//;s/ .*//' " \
        | tr -d '\r\n[:space:]')
    if [ -n "$uid" ]; then
        $ADB shell appops set --uid "$uid" CAMERA allow >/dev/null 2>&1 || true
    fi
}

# ─────────────────────────────────────────────────────────────
#  scan — 只读扫描
# ─────────────────────────────────────────────────────────────
cmd_scan() {
    log "════════════════════════════════════════"
    log "  设备扫描（只读，不执行任何改动）"
    log "════════════════════════════════════════"
    collect_device_info

    log "① 动态发现的相机相关包（将被冻结）："
    while IFS= read -r PKG; do
        [ -z "$PKG" ] && continue; ok "  $PKG"
    done < <(discover_target_pkgs "$CAMERA_KEYWORDS")

    log "② 动态发现的录屏/截图相关包（将被冻结）："
    while IFS= read -r PKG; do
        [ -z "$PKG" ] && continue; ok "  $PKG"
    done < <(discover_target_pkgs "$RECORDER_KEYWORDS")

    log "③ 当前控制中心 Tile（将移除截屏/录屏相关条目）："
    TILES=$($ADB shell settings get secure sysui_qs_tiles 2>/dev/null | tr -d '\r')
    log "  完整列表：$TILES"
    while IFS= read -r TILE; do
        [ -z "$TILE" ] && continue; warn "  → 将移除：$TILE"
    done < <(discover_screenshot_tiles)

    log "④ 已授权摄像头权限的 App（将全部撤销，保留访客 App 和系统组件）："
    local count=0
    while IFS= read -r PKG; do
        [ -z "$PKG" ] && continue
        if is_exempt "$PKG"; then
            debug "  [豁免] $PKG"
        else
            ok "  [将撤销] $PKG"
            ((count++)) || true
        fi
    done < <(discover_camera_granted_pkgs)
    log "  共 $count 个 App 将被撤销摄像头权限"

    log "════════════════════════════════════════"
    ok "  扫描完成，运行 apply 执行管控"
    log "════════════════════════════════════════"
}

# ─────────────────────────────────────────────────────────────
#  apply — 进厂管控
# ─────────────────────────────────────────────────────────────
cmd_apply() {
    log "════════════════════════════════════════"
    log "  开始下发管控指令"
    log "════════════════════════════════════════"
    collect_device_info

    # ── 预扫描：在任何 pm 操作之前抓取摄像头授权列表 ─────────────
    # 关键：pm disable-user 执行后，dumpsys package 对被禁用包的权限行格式会改变，
    # grep 匹配不到，导致步骤③只能发现极少数包。
    # 解决方案：最先执行扫描，把结果存入变量，步骤③直接用这份列表。
    log "（预扫描：获取摄像头授权 App 列表，请稍候…）"
    local CAMERA_PKGS_PRESCAN=""
    local prescan_count=0
    while IFS= read -r PKG; do
        [ -z "$PKG" ] && continue
        is_exempt "$PKG" && continue
        CAMERA_PKGS_PRESCAN="${CAMERA_PKGS_PRESCAN}${PKG}|"
        ((prescan_count++)) || true
    done < <(discover_camera_granted_pkgs)
    CAMERA_PKGS_PRESCAN="${CAMERA_PKGS_PRESCAN%|}"
    debug "预扫描发现 $prescan_count 个摄像头授权 App：${CAMERA_PKGS_PRESCAN:-（无）}"

    # ── ① 冻结相机/录屏 App ──────────────────────────────────
    log "① 冻结相机/录屏相关 App…"
    local DISABLED_PKGS=""

    # 合并动态发现 + 兜底列表，收入临时数组
    local ALL_PKG_SET=()
    while IFS= read -r PKG; do
        [ -n "$PKG" ] && ALL_PKG_SET+=("$PKG")
    done < <(discover_target_pkgs "${CAMERA_KEYWORDS}|${RECORDER_KEYWORDS}")

    # 追加兜底静态列表中未被动态发现的包
    for PKG in "${FALLBACK_CAMERA_PKGS[@]}" "${FALLBACK_RECORDER_PKGS[@]}"; do
        local already=false
        for d in "${ALL_PKG_SET[@]:-}"; do
            [ "$d" = "$PKG" ] && already=true && break
        done
        $already || ALL_PKG_SET+=("$PKG")
    done

    # 记录所有目标包的原始状态（无论当前是启用还是禁用）
    # 格式：pkg|0（原本启用）或 pkg|1（原本已禁用）
    # remove 时按此快照还原：原本启用的恢复启用，原本已禁用的保持禁用
    local PKG_ORIG_STATE=""

    for PKG in "${ALL_PKG_SET[@]:-}"; do
        [ -z "$PKG" ] && continue
        local installed
        installed=$($ADB shell "pm list packages '$PKG' 2>/dev/null | grep -q 'package:${PKG}$' && echo 1 || echo 0" \
            | tr -d '\r\n')
        [ "$installed" = "1" ] || continue

        local was_disabled
        was_disabled=$($ADB shell "pm list packages -d '$PKG' 2>/dev/null | grep -q 'package:${PKG}$' && echo 1 || echo 0" \
            | tr -d '\r\n')

        # 记录原始状态（0=原本启用，1=原本已禁用）
        PKG_ORIG_STATE="${PKG_ORIG_STATE}${PKG}:${was_disabled}|"

        if [ "$was_disabled" = "1" ]; then
            debug "  [已禁用·跳过] $PKG (原始状态=禁用)"; continue
        fi
        if $ADB shell pm disable-user --user 0 "$PKG" >/dev/null 2>&1; then
            ok "  [禁用] $PKG"
            DISABLED_PKGS="${DISABLED_PKGS}${PKG}|"
        else
            warn "  [失败] $PKG（系统保护，跳过）"
        fi
    done

    DISABLED_PKGS="${DISABLED_PKGS%|}"
    PKG_ORIG_STATE="${PKG_ORIG_STATE%|}"
    save_state "disabled_pkgs" "$DISABLED_PKGS"
    save_state "pkg_orig_state" "$PKG_ORIG_STATE"   # 完整原始状态快照
    debug "已禁用包快照：${DISABLED_PKGS:-（无）}"
    debug "原始状态快照：${PKG_ORIG_STATE:-（无）}"

    # ── ② 系统截屏全局策略 ────────────────────────────────────
    log "② 设置系统截屏禁止策略…"
    local orig_val
    orig_val=$($ADB shell settings get global policy_disable_screen_capture 2>/dev/null | tr -d '\r')
    # FIX-3: "null" 和空值均视为 "0"，不把已设为 1 的值当成 0 保存
    case "$orig_val" in
        ""|"null") orig_val="0" ;;
    esac
    save_state "orig_capture" "$orig_val"
    debug "原始 policy_disable_screen_capture = $orig_val"
    $ADB shell settings put global policy_disable_screen_capture 1 \
        && ok "  policy_disable_screen_capture = 1" \
        || warn "  此机型不支持该全局策略（继续）"

    # ── ③ 撤销所有 App 的摄像头权限（使用预扫描列表，避免 pm 操作后的干扰）──
    log "③ 撤销所有 App 的摄像头权限…"
    local REVOKED_PKGS="" revoke_count=0 skip_count=0
    while IFS= read -r PKG; do
        [ -z "$PKG" ] && continue
        if is_exempt "$PKG"; then
            debug "  [豁免] $PKG"
            ((skip_count++)) || true
            continue
        fi
        revoke_camera_for_pkg "$PKG"
        # 验证 appops 是否实际生效（不依赖命令返回值）
        local verify
        verify=$($ADB shell appops get "$PKG" CAMERA 2>/dev/null \
            | grep "^CAMERA:" | tr -d '\r' || true)
        if echo "$verify" | grep -q "deny"; then
            ok "  [已撤销] $PKG"
        else
            local perm_check
            perm_check=$($ADB shell "dumpsys package '$PKG' 2>/dev/null \
                | grep 'CAMERA' | grep 'granted=' | head -1" | tr -d '\r' || true)
            if echo "$perm_check" | grep -q "granted=false"; then
                ok "  [已撤销·pm] $PKG（权限已撤销，appops 无记录）"
            else
                warn "  [部分生效] $PKG（appops=$verify）"
            fi
        fi
        REVOKED_PKGS="${REVOKED_PKGS}${PKG}|"
        ((revoke_count++)) || true
    done < <(echo "$CAMERA_PKGS_PRESCAN" | tr '|' '\n')

    # ③-扩展：强制额外处理一组指定包名（不依赖预扫描是否 granted）
    if [ "${#FORCE_CAMERA_PKGS[@]}" -gt 0 ]; then
        log "③-扩展：强制额外撤销指定 App 的摄像头权限…"
        for PKG in "${FORCE_CAMERA_PKGS[@]}"; do
            [ -z "$PKG" ] && continue
            if is_exempt "$PKG"; then
                debug "  [豁免·强制列表] $PKG"
                continue
            fi
            # 若已在预扫描列表中处理过，则跳过，避免重复记录
            case "|$REVOKED_PKGS|" in
                *"|$PKG|"*)
                    debug "  [已处理·跳过强制] $PKG"
                    continue
                    ;;
            esac
            revoke_camera_for_pkg "$PKG"
            ok "  [已撤销·强制] $PKG"
            if [ -n "$REVOKED_PKGS" ]; then
                REVOKED_PKGS="${REVOKED_PKGS}|${PKG}"
            else
                REVOKED_PKGS="${PKG}"
            fi
            ((revoke_count++)) || true
        done
    fi

    REVOKED_PKGS="${REVOKED_PKGS%|}"
    save_state "revoked_pkgs" "$REVOKED_PKGS"
    ok "  共处理 $revoke_count 个 App 的摄像头权限（跳过 $skip_count 个豁免组件）"

    # ── ④ 保护访客 App 不被卸载 ──────────────────────────────
    log "④ 保护访客 App 不被卸载…"
    $ADB shell pm hide "$FACTORY_APP_PKG" >/dev/null 2>&1 \
        && ok "  [已隐藏] $FACTORY_APP_PKG（应用列表不可见）" \
        || warn "  pm hide 不支持（Device Admin 激活后仍有保护）"

    # ── ⑤ 移除控制中心截屏/录屏 Tile ─────────────────────────
    log "⑤ 移除控制中心截屏/录屏快捷按钮…"
    local orig_tiles
    orig_tiles=$($ADB shell settings get secure sysui_qs_tiles 2>/dev/null | tr -d '\r')
    if [ -n "$orig_tiles" ] && [ "$orig_tiles" != "null" ]; then
        save_state "orig_tiles" "$orig_tiles"
        debug "原始 tiles 已备份：$orig_tiles"

        local new_tiles="$orig_tiles" removed_count=0
        while IFS= read -r TILE; do
            [ -z "$TILE" ] && continue
            new_tiles=$(echo "$new_tiles" \
                | sed "s/,${TILE}//g; s/${TILE},//g; s/^${TILE}$//g" \
                | sed 's/,,/,/g; s/^,//; s/,$//')
            ok "  [移除 Tile] $TILE"
            ((removed_count++)) || true
        done < <(discover_screenshot_tiles)

        if [ "$removed_count" -gt 0 ]; then
            # BUG-3 FIX: tiles 值可能含 custom(pkg/class) 括号，直接拼入命令字符串
            #            会让远端 /bin/sh 报 syntax error。
            #            改为先把新 tiles 值写到设备临时文件，再用 $(...) 读取执行，
            #            避免括号被 shell 解析为子命令。
            printf '%s' "$new_tiles" | $ADB shell "cat > $SAVE_DIR/tiles_new" 2>/dev/null || true
            $ADB shell "settings put secure sysui_qs_tiles \"\$(cat $SAVE_DIR/tiles_new)\"" \
                && ok "  当前 tiles：$new_tiles"
            # 动态获取 SystemUI 包名（不硬编码）
            local sysui_pkg
            sysui_pkg=$($ADB shell pm list packages 2>/dev/null \
                | grep -i systemui \
                | grep -v "overlay\|navbar\|gestural\|threebutton\|hide" \
                | head -1 | sed 's/package://' | tr -d '\r')
            sysui_pkg="${sysui_pkg:-com.android.systemui}"
            $ADB shell killall "$sysui_pkg" >/dev/null 2>&1 \
                && ok "  SystemUI ($sysui_pkg) 已重启，控制中心立即生效" \
                || warn "  SystemUI 重启失败，下拉控制中心后生效"
        else
            warn "  当前 tiles 中未发现截屏/录屏按钮，跳过"
        fi
    else
        warn "  无法读取 sysui_qs_tiles，跳过"
    fi

    # ── ⑥ 通知 App ───────────────────────────────────────────
    $ADB shell am broadcast \
        -a com.factory.control.UPDATE_STATUS \
        --es status restricted \
        --include-stopped-packages >/dev/null 2>&1 \
        && ok "  已通知访客 App 进入管控状态"

    log "════════════════════════════════════════"
    ok "  全部管控指令下发完成"
    log "════════════════════════════════════════"
}

# ─────────────────────────────────────────────────────────────
#  remove — 离厂解除（精确还原快照）
# ─────────────────────────────────────────────────────────────
cmd_remove() {
    log "════════════════════════════════════════"
    log "  开始解除管控"
    log "════════════════════════════════════════"
    collect_device_info

    # ── ① 恢复被冻结的 App（按原始状态快照还原）─────────────────
    log "① 恢复被冻结的 App…"
    local pkg_orig_state
    pkg_orig_state=$(load_state "pkg_orig_state")

    if [ -n "$pkg_orig_state" ]; then
        # 新版快照：格式 pkg:0|pkg:1|...  （0=原本启用，1=原本已禁用）
        # 只恢复原本是启用状态（:0）的包，原本就禁用的（:1）保持禁用
        while IFS= read -r ENTRY <&3; do
            [ -z "$ENTRY" ] && continue
            local PKG="${ENTRY%:*}"
            local WAS_DISABLED="${ENTRY##*:}"
            [ -z "$PKG" ] && continue
            if [ "$WAS_DISABLED" = "0" ]; then
                if $ADB shell pm enable --user 0 "$PKG" >/dev/null 2>&1 </dev/null; then
                    ok "  [已恢复] $PKG"
                else
                    warn "  [失败] $PKG"
                fi
            else
                debug "  [保持禁用] $PKG（进厂前已是禁用状态，不恢复）"
            fi
        done 3< <(echo "$pkg_orig_state" | tr '|' '\n')
    else
        # 兼容旧版快照（只有 disabled_pkgs，无原始状态信息）
        warn "  未找到原始状态快照，使用旧版快照恢复…"
        local disabled_pkgs
        disabled_pkgs=$(load_state "disabled_pkgs")
        if [ -n "$disabled_pkgs" ]; then
            while IFS= read -r PKG <&3; do
                [ -z "$PKG" ] && continue
                $ADB shell pm enable --user 0 "$PKG" >/dev/null 2>&1 </dev/null \
                    && ok "  [已恢复] $PKG" || warn "  [失败] $PKG"
            done 3< <(echo "$disabled_pkgs" | tr '|' '\n')
        else
            warn "  未找到任何禁用记录，尝试动态扫描恢复…"
            while IFS= read -r PKG <&3; do
                [ -z "$PKG" ] && continue
                $ADB shell pm enable --user 0 "$PKG" >/dev/null 2>&1 </dev/null \
                    && ok "  [已恢复·扫描] $PKG" || true
            done 3< <(discover_target_pkgs "${CAMERA_KEYWORDS}|${RECORDER_KEYWORDS}")
        fi
    fi

    # ── ② 恢复系统截屏策略 ────────────────────────────────────
    log "② 恢复系统截屏策略…"
    local orig_capture
    orig_capture=$(load_state "orig_capture")
    orig_capture=$(echo "$orig_capture" | tr -cd '0-9')
    orig_capture="${orig_capture:-0}"
    $ADB shell settings put global policy_disable_screen_capture "$orig_capture" \
        && ok "  policy_disable_screen_capture = $orig_capture（已还原）"

    # ── ③ 恢复所有被撤销摄像头权限的 App ─────────────────────
    log "③ 恢复所有 App 的摄像头权限…"
    local revoked_pkgs restore_count=0
    revoked_pkgs=$(load_state "revoked_pkgs")
    if [ -n "$revoked_pkgs" ]; then
        # FIX-2: fd3 读取，避免 adb 命令消耗循环输入导致只处理第一项
        while IFS= read -r PKG <&3; do
            [ -z "$PKG" ] && continue
            restore_camera_for_pkg "$PKG"
            ok "  [摄像头已恢复] $PKG"
            ((restore_count++)) || true
        done 3< <(echo "$revoked_pkgs" | tr '|' '\n')
        ok "  共恢复 $restore_count 个 App 的摄像头权限"
    else
        warn "  未找到权限撤销记录，跳过"
    fi

    # ── ④ 恢复访客 App 可见性 ─────────────────────────────────
    log "④ 恢复访客 App 可见性…"
    $ADB shell pm unhide "$FACTORY_APP_PKG" >/dev/null 2>&1 \
        && ok "  [已恢复可见] $FACTORY_APP_PKG" || true

    # ── ⑤ 还原控制中心 Tiles ─────────────────────────────────
    log "⑤ 还原控制中心快捷按钮…"
    local orig_tiles
    orig_tiles=$(load_state "orig_tiles")
    if [ -n "$orig_tiles" ]; then
        # BUG-3 FIX: 同 apply，tiles 值可能含括号，必须走文件中转写入
        printf '%s' "$orig_tiles" | $ADB shell "cat > $SAVE_DIR/tiles_restore" 2>/dev/null || true
        $ADB shell "settings put secure sysui_qs_tiles \"\$(cat $SAVE_DIR/tiles_restore)\"" \
            && ok "  tiles 已精确还原：$orig_tiles" \
            || warn "  tiles 还原失败"
    else
        warn "  未找到 tiles 备份，跳过（访客可手动从控制中心添加回快捷按钮）"
    fi
    $ADB shell killall com.android.systemui >/dev/null 2>&1 \
        && ok "  SystemUI 已重启" || true

    # ── ⑥ 关闭无线调试 ───────────────────────────────────────
    log "⑥ 关闭无线调试…"
    # 方案A：直接写 settings（HarmonyOS/部分机型会被 SELinux 拒绝）
    if $ADB shell settings put global adb_wifi_enabled 0 >/dev/null 2>&1; then
        ok "  无线调试已关闭（ADB 连接将断开）"
    else
        # 方案B：关闭开发者模式下的无线调试开关
        $ADB shell "settings put global development_settings_enabled 0" >/dev/null 2>&1 || true
        # 方案C：通过 svc 关闭 WiFi，彻底断开 ADB 连接
        $ADB shell "svc wifi disable" >/dev/null 2>&1 \
            && ok "  已通过关闭 WiFi 断开 ADB 连接（访客离开后 WiFi 可手动恢复）" \
            || warn "  无线调试关闭失败，请手动在「开发者选项」中关闭无线调试"
    fi

    # ── ⑦ 清除备份 + 通知 App ────────────────────────────────
    clear_state
    debug "设备端状态文件已清除"
    $ADB shell am broadcast \
        -a com.factory.control.UPDATE_STATUS \
        --es status exited \
        --include-stopped-packages >/dev/null 2>&1 \
        && ok "  已通知访客 App 解除管控" || true

    log "════════════════════════════════════════"
    ok "  全部管控已解除"
    log "════════════════════════════════════════"
}

# ─────────────────────────────────────────────────────────────
#  status — 状态检查
# ─────────────────────────────────────────────────────────────
cmd_status() {
    log "════════════════════════════════════════"
    log "  当前设备管控状态"
    log "════════════════════════════════════════"
    collect_device_info

    log "① 相机/录屏 App 状态："
    local snap_state found_any=false
    snap_state=$(load_state "pkg_orig_state")
    if [ -n "$snap_state" ]; then
        # 优先用快照：pm list packages 在 HarmonyOS 上不总能枚举 disable-user 过的包
        while IFS= read -r ENTRY; do
            [ -z "$ENTRY" ] && continue
            local PKG="${ENTRY%:*}"
            [ -z "$PKG" ] && continue
            found_any=true
            local s
            s=$($ADB shell "pm list packages -d '$PKG' 2>/dev/null | grep -q 'package:${PKG}' && echo 1 || echo 0" \
                | tr -d '\r\n')
            [ "$s" = "1" ] && ok "  [已禁用] $PKG" || warn "  [运行中] $PKG"
        done < <(echo "$snap_state" | tr '|' '\n')
    else
        # 无快照时降级为动态发现
        while IFS= read -r PKG; do
            [ -z "$PKG" ] && continue; found_any=true
            local s
            s=$($ADB shell "pm list packages -d '$PKG' 2>/dev/null | grep -q 'package:${PKG}' && echo 1 || echo 0" \
                | tr -d '\r\n')
            [ "$s" = "1" ] && ok "  [已禁用] $PKG" || warn "  [运行中] $PKG"
        done < <(discover_target_pkgs "${CAMERA_KEYWORDS}|${RECORDER_KEYWORDS}")
    fi
    $found_any || debug "  未发现相机/录屏相关包（apply 未执行？）"

    log "② 系统截屏策略："
    local val
    val=$($ADB shell settings get global policy_disable_screen_capture 2>/dev/null | tr -d '\r')
    [ "$val" = "1" ] \
        && ok   "  policy_disable_screen_capture = 1（已禁止）" \
        || warn "  policy_disable_screen_capture = ${val:-null}（未禁止）"

    log "③ 控制中心截屏/录屏 Tile："
    local cur_tiles found_tile=false
    cur_tiles=$($ADB shell settings get secure sysui_qs_tiles 2>/dev/null | tr -d '\r')
    while IFS= read -r T; do
        [ -z "$T" ] && continue
        echo "$T" | grep -qiE "$TILE_REMOVE_KEYWORDS" || continue
        warn "  [存在] $T（未移除）"; found_tile=true
    done < <(echo "$cur_tiles" | tr ',' '\n')
    $found_tile || ok "  截屏/录屏 Tile 均已移除"

    log "④ 摄像头权限状态（当前仍有授权的 App）："
    local still_granted=0
    while IFS= read -r PKG; do
        [ -z "$PKG" ] && continue
        is_exempt "$PKG" && continue
        local op
        op=$($ADB shell appops get "$PKG" CAMERA 2>/dev/null | grep "^CAMERA:" | tr -d '\r' || true)
        if echo "$op" | grep -q "deny"; then
            ok "  [已撤销] $PKG"
        else
            warn "  [仍授权] $PKG  ($op)"
            ((still_granted++)) || true
        fi
    done < <(discover_camera_granted_pkgs)
    [ "$still_granted" -gt 0 ] \
        && warn "  $still_granted 个 App 仍有摄像头权限" \
        || ok   "  所有非系统 App 摄像头权限已撤销"

    log "⑤ 访客 App 状态："
    local pid
    pid=$($ADB shell pidof "$FACTORY_APP_PKG" 2>/dev/null | tr -d '\r')
    [ -n "$pid" ] \
        && ok   "  $FACTORY_APP_PKG 运行中 (PID: $pid)" \
        || warn "  $FACTORY_APP_PKG 未在运行"

    log "⑥ 备份状态文件："
    local t p
    t=$(load_state "orig_tiles" 2>/dev/null)
    p=$(load_state "disabled_pkgs" 2>/dev/null)
    [ -n "$t" ] && ok "  orig_tiles 存在" || warn "  orig_tiles 不存在（apply 未执行？）"
    [ -n "$p" ] && ok "  disabled_pkgs 存在" || warn "  disabled_pkgs 不存在"
}

# ─────────────────────────────────────────────────────────────
#  主入口
# ─────────────────────────────────────────────────────────────
CMD="${1:-help}"
ARG2="${2:-}"

if [ "$CMD" = "help" ] || [ "$CMD" = "-h" ] || [ "$CMD" = "--help" ]; then
    echo ""
    echo "用法: $0 <命令> [设备序列号]"
    echo ""
    echo "  scan    扫描：列出将要操作的内容，不执行任何改动"
    echo "  apply   进厂：动态发现、冻结相机录屏 App、撤销全部 App 摄像头权限"
    echo "  remove  离厂：精确还原所有快照，只还原改过的部分"
    echo "  status  查看：检查当前管控状态"
    echo ""
    echo "多设备示例:"
    echo "  $0 apply  adb-XXXX._adb-tls-connect._tcp"
    echo "  $0 remove adb-XXXX._adb-tls-connect._tcp"
    echo ""
    exit 0
fi

select_device "$ARG2"

case "$CMD" in
    scan)   cmd_scan   ;;
    apply)  cmd_apply  ;;
    remove) cmd_remove ;;
    status) cmd_status ;;
    *)
        err "未知命令：$CMD"
        echo "运行 $0 help 查看用法"
        exit 1
        ;;
esac