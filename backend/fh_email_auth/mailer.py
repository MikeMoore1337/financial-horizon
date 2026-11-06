"""Send verification / password-reset mail using external TLS SMTP relay.

No local SMTP daemon. Based on YFC's smtplib pattern but independent settings.
"""
from __future__ import annotations
from email.message import EmailMessage
from urllib.parse import quote
import smtplib
import ssl

from .config import Settings


class Mailer:
    def __init__(self,config:Settings):
        self.config=config

    def send(self,email:str,purpose:str,token:str)->bool:
        if purpose=="verify":
            subject="Подтвердите email - Финансовый горизонт"
            fragment="verify-email="+quote(token,safe="")
            text="Подтвердите адрес и задайте собственный пароль по ссылке. Она действует 24 часа."
        elif purpose=="reset":
            subject="Восстановление доступа - Финансовый горизонт"
            fragment="reset-password="+quote(token,safe="")
            text="Чтобы назначить новый пароль, откройте ссылку. Она действует 1 час."
        elif purpose=="email-change":
            subject="Подтвердите новый email - Финансовый горизонт"
            fragment="confirm-email-change="+quote(token,safe="")
            text="Подтвердите новый адрес для вашего аккаунта. Ссылка действует 1 час, и вы должны войти в прежний аккаунт."
        elif purpose=="email-changed":
            subject="Адрес аккаунта изменён - Финансовый горизонт"
            fragment=None
            text="Адрес электронной почты аккаунта изменён. Если это сделали не вы, проверьте безопасность аккаунта."
        else:
            raise ValueError("Invalid mail purpose")
        url=self.config.public_origin+"/account.html"+("#"+fragment if fragment else "")
        msg=EmailMessage()
        msg["From"]=self.config.smtp_from
        msg["To"]=email
        msg["Subject"]=subject
        msg.set_content(text+"\n\n"+url+"\n\nЕсли вы не запрашивали это действие, проигнорируйте письмо.")
        context=ssl.create_default_context()
        if self.config.smtp_port==465:
            with smtplib.SMTP_SSL(self.config.smtp_host,self.config.smtp_port,timeout=12,context=context) as connection:
                connection.login(self.config.smtp_username,self.config.smtp_password)
                connection.send_message(msg)
        elif self.config.smtp_port==587:
            with smtplib.SMTP(self.config.smtp_host,self.config.smtp_port,timeout=12) as connection:
                connection.ehlo()
                connection.starttls(context=context)
                connection.ehlo()
                connection.login(self.config.smtp_username,self.config.smtp_password)
                connection.send_message(msg)
        else:
            raise ValueError("TLS SMTP port is required")
        return True
