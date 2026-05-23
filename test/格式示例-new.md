# Markdown 格式示例
## 文字样式

普通段落文本，支持 **粗体**、*斜体*、***粗斜体***、~~删除线~~、`行内代码`。


组合使用：~~旧版本~~ **新版本**，`status: "PAID"` 表示已支付，*详见第三节*。

## 标题层级
# 一级标题
## 二级标题
### 三级标题
#### 四级标题
##### 五级标题
###### 六级标题
## 列表
### 无序列表
- 苹果
- 香蕉
  - 大蕉
  - 小蕉
    - 进口小蕉
    - 国产小蕉
- 橙子
### 有序列表
- 安装依赖：`npm install`
- 配置环境变量
  - 复制 `.env.example` 为 `.env`
  - 填写 `DATABASE_URL` 和 `REDIS_URL`
- 启动服务：`npm run dev`
- 访问 `http://localhost:3000`
### 任务列表
- ✅ 完成需求评审
- ✅ 完成接口设计
- ✅ 完成开发联调
- 完成性能测试
- 完成上线部署
## 引用

> 简单引用文本。


> **注意**：这是一个重要提示，部署前请确认已备份数据库。
>
> 引用可以包含多个段落，在每行前加 `>` 即可。


> 嵌套引用：
>> 这是内层引用，适合引用他人回复。

## 代码
### 行内代码

使用 `git commit -m "message"` 提交，使用 `git push origin main` 推送。

### 代码块（无语言）

```
plain text code block
no syntax highlight
```

### JavaScript

```javascript
async function createOrder(userId, items) {
  const idempotencyKey = crypto.randomUUID();

  const response = await fetch('/api/v2/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`,
      'X-Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ userId, items }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`创建订单失败: ${error.code}`);
  }

  return response.json();
}
```

### SQL

```sql
--noinspection SqlNoDataSourceInspection
SELECT
  o.order_id,
  o.user_id,
  o.status,
  o.payable_amount,
  COUNT(oi.id) AS item_count
FROM orders o
LEFT JOIN order_items oi ON o.order_id = oi.order_id
WHERE o.status IN ('PAID', 'SHIPPED')
  AND o.created_at >= '2024-06-01'
GROUP BY o.order_id
ORDER BY o.created_at DESC
LIMIT 20;
```

### Shell

```bash
# 启动服务
export NODE_ENV=production
export PORT=8080
node dist/main.js

# 健康检查
curl -s http://localhost:8080/health | jq .
```

### JSON

```json
{
  "orderId": "ord_20240601_8823",
  "status": "PAID",
  "items": [
    { "skuId": "sku_001", "name": "机械键盘", "quantity": 1, "price": 49900 }
  ],
  "totalAmount": 49900,
  "paidAt": "2024-06-01T10:25:00Z"
}
```

## 表格
### 基础表格

| 姓名 | 角色 | 负责模块 |
| --- | --- | --- |
| 张三 | 后端工程师 | 用户服务、订单服务 |
| 李四 | 后端工程师 | 商品服务、搜索 |
| 王五 | 前端工程师 | Web 端、BFF |
| 赵六 | 运维工程师 | K8s、CI/CD |

### 对齐方式

| 左对齐 | 居中对齐 | 右对齐 |
| --- | --- | --- |
| 苹果 | 水果 | ¥5.00 |
| 牛奶 | 饮品 | ¥12.50 |
| 面包 | 主食 | ¥8.00 |

### 含代码和格式的表格

| 接口 | 方法 | 认证 | 限流 |
| --- | --- | --- | --- |
| `/api/v2/orders` | `POST` | **必须** | 100 req/min |
| `/api/v2/orders/{id}` | `GET` | **必须** | 500 req/min |
| `/api/health` | `GET` | 不需要 | 无限制 |

## 链接与图片
### 链接

普通链接：[GitHub](https://github.com)


带标题的链接：[Markdown 语法](https://commonmark.org "CommonMark 规范")


引用式链接：[项目文档][docs]


[docs]: https://example.com/docs "项目文档首页"

### 图片

![示意图](https://via.placeholder.com/400x200 "流程示意图")

## 分隔线

三种写法效果相同：

## 转义字符

以下字符需要转义：\* \_ \` \\ \[ \] \# \+ \- \. \!


示例：这不是 \*斜体\*，这也不是 \`行内代码\`。

