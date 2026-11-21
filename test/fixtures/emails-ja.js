/**
 * Hand-written Japanese emails for the extractor tests. They copy the shapes
 * Japanese senders use (【】 and 「」 brackets, full-width digits, no spaces
 * between words, 有効期限 lines, company footers with 〒 and 電話番号)
 * without copying any real email.
 *
 * `expect` is the code that should be found, or null when nothing should be.
 */

const wrap = inner => `<!doctype html><html><head><meta charset="utf-8"><title>お知らせ</title></head><body><table width="100%"><tr><td>${inner}</td></tr></table><p style="color:#999">株式会社サンプル 〒100-0001 東京都千代田区千代田1-1 電話番号 03-1234-5678<br>© 2026 Sample Inc.</p></body></html>`;

export const POSITIVE_JA = [
  {
    name: 'ja: label, は, code, です with no spaces',
    subject: '【サンプル】認証コードのお知らせ',
    text: 'いつもご利用ありがとうございます。\nあなたの認証コードは123456です。\n有効期限は10分です。',
    expect: '123456'
  },
  {
    name: 'ja: full-width digits and colon',
    subject: '確認コード',
    text: '確認コード：４８２９１３\nこのコードの有効期限は30分です。',
    expect: '482913'
  },
  {
    name: 'ja: code in 「」',
    subject: 'ログインの確認',
    text: 'ログイン用の確認コードは「730154」です。画面に入力してください。',
    expect: '730154'
  },
  {
    name: 'ja: code in 【】 in the subject, label after',
    subject: '【591027】はあなたのログイン用確認コードです',
    text: 'このコードを他人に教えないでください。',
    expect: '591027'
  },
  {
    name: 'ja: one-time password, eight digits',
    subject: 'ワンタイムパスワードのご案内',
    text: 'ワンタイムパスワード：40418822\n※ワンタイムパスワードの有効期限は発行から5分です。',
    expect: '40418822'
  },
  {
    name: 'ja: label line, code alone on the next line',
    subject: 'メールアドレスの確認',
    text: 'サンプルをご利用いただきありがとうございます。\n以下の認証番号を入力してください。\n\n662190\n\n有効期限は10分です。お心当たりのない場合は、このメールを破棄してください。',
    expect: '662190'
  },
  {
    name: 'ja: code first, then が and label',
    subject: 'サインイン',
    text: '319004 があなたのサインイン用の認証コードです。',
    expect: '319004'
  },
  {
    name: 'ja: passcode, four digits',
    subject: 'パスコードのお知らせ',
    text: 'パスコード：7741\n上記のパスコードを入力して手続きを完了してください。',
    expect: '7741'
  },
  {
    name: 'ja: html table cell with styled code and company footer',
    subject: '【重要】本人確認のお願い',
    html: wrap('<p>本人確認のため、以下の確認コードを画面に入力してください。</p><div style="font-size:28px;font-weight:bold;letter-spacing:4px">827710</div><p>有効期限：2026年11月21日 21:00まで</p>'),
    expect: '827710'
  },
  {
    name: 'ja: spaced digits',
    subject: '二段階認証',
    text: '二段階認証コード: 123 456\n第三者に知らせないでください。',
    expect: '123456'
  },
  {
    name: 'ja: login date line before the code',
    subject: 'ログインがありました',
    text: '2026年11月21日 20:45 に新しい端末からログインがありました。\nご本人の場合は、確認コード 552901 を入力してください。',
    expect: '552901'
  },
  {
    name: 'ja: half-width katakana label',
    subject: 'ﾜﾝﾀｲﾑﾊﾟｽﾜｰﾄﾞ',
    text: 'ﾜﾝﾀｲﾑﾊﾟｽﾜｰﾄﾞ:918273',
    expect: '918273'
  },
  {
    name: 'ja: alphanumeric code after label',
    subject: 'メール認証',
    text: '下記の認証キーを入力してください。\n認証キー：K7Q2M9\n※大文字で入力してください。',
    expect: 'K7Q2M9'
  },
  {
    name: 'ja: code followed by を入力',
    subject: 'セキュリティ確認',
    text: '本人確認のため、284615 を入力してください。',
    expect: '284615'
  },
  {
    name: 'ja: security code email with order history link',
    subject: 'セキュリティコード',
    text: 'お客様のアカウントへのアクセスを確認するため、次のセキュリティコードを入力してください。\n\n940317\n\nこのコードは10分間有効です。',
    expect: '940317'
  },
  {
    name: 'ja: code next to 円 in another sentence is ignored, label wins',
    subject: '【サンプルPay】認証コード',
    text: 'ご利用金額 12800円 のお支払いを確認するため、認証コード 604412 を入力してください。',
    expect: '604412'
  },
  {
    name: 'ja: html entities and nbsp',
    subject: '確認コードのお知らせ',
    html: wrap('<p>確認コード&nbsp;:&nbsp;<strong>&#55;&#55;&#49;&#52;&#48;&#50;</strong></p>'),
    expect: '771402'
  }
];

export const NEGATIVE_JA = [
  {
    name: 'ja: coupon code in a sale email',
    subject: '【期間限定】秋のセール開催中',
    text: 'クーポンコード：SAVE2026\nご購入金額から1000円OFF！今すぐログインしてチェック。',
    expect: null
  },
  {
    name: 'ja: order confirmation with order number',
    subject: 'ご注文ありがとうございます',
    text: 'ご注文番号：250123\nお届け予定日：11月25日\nご請求金額：5980円',
    expect: null
  },
  {
    name: 'ja: postal code and phone in a footer',
    subject: 'ニュースレター 11月号',
    text: '今月のお知らせです。\n株式会社サンプル\n〒100-0001 東京都千代田区千代田1-1\n電話番号：0120-123-456',
    expect: null
  },
  {
    name: 'ja: member number',
    subject: '会員登録完了のお知らせ',
    text: 'ご登録ありがとうございます。\n会員番号：12345678\nログインはこちらから。',
    expect: null
  },
  {
    name: 'ja: invitation code',
    subject: 'お友達紹介キャンペーン',
    text: 'あなたの招待コード：ABCD1234\nお友達が登録すると500ポイントプレゼント！',
    expect: null
  },
  {
    name: 'ja: meeting passcode',
    subject: 'ミーティングのご案内',
    text: 'Zoomミーティングに参加する\nミーティングID: 812 3456 7890\nパスコード: 482913',
    expect: null
  },
  {
    name: 'ja: date and price only',
    subject: 'ご利用明細',
    text: '2026年11月21日 ご利用金額 12800円\nご利用ポイント 1500ポイント',
    expect: null
  },
  {
    name: 'ja: inquiry number',
    subject: 'お問い合わせを受け付けました',
    text: 'お問い合わせ番号：445566\n担当者よりご連絡いたします。',
    expect: null
  },
  {
    name: 'ja: reservation number',
    subject: 'ご予約確認',
    text: 'ご予約が確定しました。\n予約番号: 834521\nチェックイン 15:00',
    expect: null
  },
  {
    name: 'ja: expired code',
    subject: '認証コードの有効期限について',
    text: '先ほどお送りした認証コード 123456 は無効になりました。再度お手続きください。',
    expect: null
  },
  {
    name: 'ja: QR code payment promo',
    subject: 'コード決済で10%還元',
    text: 'QRコード決済で最大10%還元！キャンペーンコード：AUTUMN25',
    expect: null
  },
  {
    name: 'ja: password changed notice with support phone',
    subject: 'パスワード変更のお知らせ',
    text: 'パスワードが変更されました。お心当たりがない場合は、電話 0120-111-222 までご連絡ください。',
    expect: null
  },
  {
    name: 'ja: tracking number',
    subject: '商品を発送しました',
    text: 'ご注文の商品を発送しました。\n伝票番号：1234-5678-9012\n配送業者：サンプル運輸',
    expect: null
  },
  {
    name: 'ja: ATM PIN reminder',
    subject: 'キャッシュカードのご案内',
    text: 'キャッシュカードの暗証番号 1234 のような推測されやすい番号は避けてください。',
    expect: null
  },
  {
    name: 'ja: card approval number',
    subject: 'カードご利用のお知らせ',
    text: 'カードのご利用がありました。\n承認番号：583920\nご利用金額：3,300円',
    expect: null
  },
  {
    name: 'ja: year in a newsletter',
    subject: '2026年の振り返り',
    text: '今年もご愛顧いただきありがとうございました。2026年 のサービス更新情報をお届けします。ログインはこちら。',
    expect: null
  },
  {
    name: 'ja: barcode number',
    subject: 'デジタル会員証',
    text: 'お店でバーコードを提示してください。\nバーコード番号：49012345',
    expect: null
  }
];
