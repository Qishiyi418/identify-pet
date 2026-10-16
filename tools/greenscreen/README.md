# 绿幕素材与颜色统一工具

把 AI 生成的绿幕视频做成桌宠动画，并让所有动画的发色、服装和肤色统一到角色首帧参考图。

## 准备

- Python 3.10 或以上：`pip install -r tools/greenscreen/requirements.txt`
- ffmpeg（需带 libvpx-vp9，常见发行版都带），并加入 PATH

以下命令都在项目根目录运行。中间文件放在 `work/`，该目录已被 git 忽略。

## 参考图

- `reference/first-frame.png`：角色首帧原图（绿幕）。
- `reference/first-frame-aligned.png`：由 `key.py` 抠像并对齐到 640×360 画布的版本，所有核对和校色都以它为准。

更换参考图后，用 `python tools/greenscreen/key.py tools/greenscreen/reference/first-frame.png work/ref` 重新生成，再把 `work/ref/0001.png` 复制为 `first-frame-aligned.png`。

## 新增一个动作

以“整理帽子”为例：

```powershell
# 1. 抠像并对齐到待机姿势（人物高 252，脚底中心 x 319.5、y 320），角落水印会被去掉
python tools/greenscreen/key.py 整理帽子.mov work/fix-cap

# 2. 校色并编码（首尾帧分别对准参考图，中间逐帧过渡）
python tools/greenscreen/unify.py --out work/unified --raw fix-cap=work/fix-cap fix-cap

# 3. 核对首尾帧：头发与衣服任一部位超过 2.5 时返回失败
python tools/greenscreen/check.py --max 2.5 work/unified/assets/animations/daily-idle-match-v001/fix-cap-v001-m01.webm

# 4. 装进项目：复制视频、生成首帧图、写入配置与随机规则（ID:名称:时段:权重:冷却分钟）
python tools/greenscreen/install.py --out work/unified --new fix-cap:整理帽子:any:3:5

# 5. 全量复核，包括与待机之间的衔接
python tools/greenscreen/audit.py
```

时段可选 `any`、`dayPreferred`、`nightPreferred`、`mealPreferred`、`day`、`night`、`meal`。素材要求：从统一待机姿势开始并回到待机姿势，镜头固定，24 帧/秒或以上，人物身上没有接近绿幕的颜色。

## 重新统一全部动画

```powershell
python tools/greenscreen/unify.py --out work/unified
python tools/greenscreen/install.py --out work/unified
python tools/greenscreen/audit.py
```

只处理部分动作时，在 `unify.py` 后面加分组名，如 `idle eat candy`。每个分组怎么拟合写在 `plan.json` 中，未列出的单段动作默认首尾分别对准：

| 方式 | 用于 | 做法 |
| --- | --- | --- |
| `ramp` | 首尾都是待机姿势的单段动作 | 首帧、末帧各自按部位对准参考图，中间线性过渡，同时消除片段内的颜色漂移 |
| `group` | 起始 / 循环 / 收尾三段的动作 | 起始从首帧校正过渡到中间值，循环段固定，收尾再过渡到末帧校正；循环与段间衔接不跳色 |
| `first` / `last` | 只有一端是待机姿势 | 用那一端拟合，整段共用 |
| `colour` | 跑步、撑伞、摸头、摔倒等特殊姿势 | 不依赖姿势的颜色分类（头发、红、黑、白、皮肤），整段汇总拟合，可排除道具颜色 |
| `colour-last` | 拖起、打招呼 | 特殊姿势段用颜色分类，最后一段过渡到末帧待机姿势的部位拟合 |

校色只改颜色，不改位置和尺寸。拟合是 3×4 色彩矩阵，头发与衣服权重加倍，并向“不改动”收敛以免过度校正。编码为 VP9 透明通道、CRF 2，重新编码的画质损失可忽略。

## 怎么读数值

颜色差用 CIEDE2000：小于 1 基本看不出，约 2 需要并排细看，超过 3.5 一眼可见。`audit.py` 输出每段动作待机姿势首尾帧的“头发与衣服”“皮肤 / 眼睛 / 蝴蝶结”最大色差、人物高度与脚底位置，以及各处衔接的跳色。

全局色彩矩阵对同色输入只能给出同一输出。如果某段原片里两个部位的相对关系与参考图不同（例如上衣和白彩球一样亮），残留差异只能靠重新生成素材解决。

与旧版本对比：

```powershell
git archive -o work/before.tar <提交> assets config
mkdir work/before
tar -xf work/before.tar -C work/before
python tools/greenscreen/audit.py --repo work/before --json work/before.json
```
