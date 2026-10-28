# auth-session Specification

## Purpose
提供「两人自用」的口令登录与会话能力：前端只收集用户与口令，凭证全部经后端校验，登录态以 HTTP-only Cookie 维持；前端代码不存放任何密钥。

## Requirements

### Requirement: 口令登录
系统 SHALL 在登录表单中提供 `yuge`（我）与 `meimei`（老婆）两个身份选项和一个口令输入框，提交后把 `{user, pass}` POST 到后端 `/api/login`。后端校验通过后由浏览器保存服务端下发的签名 Cookie，前端 SHALL NOT 在本地代码、`localStorage` 或任何文件里写入口令或令牌。

#### Scenario: 正确口令登录成功
WHEN 用户在登录页选择身份并输入正确口令提交
THEN 系统向 `/api/login` 发送 `{user, pass}`，收到 200 后进入主界面，且此后对 `/api/me` 的请求会带上已保存的 Cookie，返回当前用户名。

#### Scenario: 口令错误提示不泄露细节
WHEN 用户提交错误口令
THEN 系统 SHALL 显示错误提示，界面保持登录态，且 SHALL NOT 在前端页面渲染任何与后端存储口径有关的内部信息。

### Requirement: 无凭证的公开前端
前端仓库是公开仓库，系统 SHALL NOT 在 `index.html` / `app.js` 及其余任何被提交的文件中写入密钥、口令、后端内部地址或个人信息。所有凭证只存在于后端环境（Worker 环境变量 / 服务器 `.env`）。

#### Scenario: 静态扫描不含密钥
WHEN 审计任何已提交的静态资源
THEN 不得在源码、构建产物、配置或测试装置中找到明文口令、令牌或后端内部密钥。

### Requirement: 会话持久与登出
登录态 SHALL 在关闭标签页后仍保持（持久 Cookie），并提供一个显式登出入口：调用 `/api/logout` 清除 Cookie 后回到登录界面。

#### Scenario: 重开标签页仍登录
WHEN 用户登录后关闭标签页并在稍后重新打开站点
THEN 系统依据已保存的 Cookie 保持登录态，直接进入主界面而不要求再次输入口令。

#### Scenario: 显式退出
WHEN 用户从菜单选择「退出登录」
THEN 系统调用 `/api/logout` 清除 Cookie，随后展示登录界面。
