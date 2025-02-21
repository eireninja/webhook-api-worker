import tkinter as tk
from tkinter import ttk, messagebox
import requests
import json
import logging
from typing import Dict, Any

# Constants
WEBHOOK_URL = "https://webhook.quantmarketintelligence.com/"
AUTH_TOKEN = "z8V%kewzQ%m%XKdMJGdWtbX8!V8ZKqHz"

# Setup logging
logging.basicConfig(
    filename="webhook_log.log",
    level=logging.DEBUG,
    format="%(asctime)s - %(levelname)s - %(message)s"
)

class WebhookApp(tk.Tk):
    def __init__(self):
        super().__init__()
        
        self.title("Trading Webhook Tester")
        self.geometry("500x700")

        # Trading pairs by type
        self.trading_pairs = {
            "spot": ["BTC-USDT", "ETH-USDT"],
            "perps": ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "BTC-USD-SWAP", "ETH-USD-SWAP"],
            "invperps": ["BTC-USD-SWAP", "ETH-USD-SWAP"]
        }
        
        # Common quantities
        self.qty_presets = ["100%", "75%", "50%", "25%", "10%", "5%"]
        
        self.variables = {
            "exchange_var": tk.StringVar(value="okx"), 
            "type_var": tk.StringVar(value="spot"),
            "symbol_var": tk.StringVar(),
            "side_var": tk.StringVar(),
            "qty_var": tk.StringVar(),
            "margin_mode_var": tk.StringVar(value="cross"),
            "leverage_var": tk.StringVar(value="10"),
            "close_position_var": tk.BooleanVar()
        }

        # Store widget references
        self.side_dropdown = None
        self.qty_entry = None

        self.build_form()

    def build_form(self):
        # Main container with padding
        container = ttk.Frame(self, padding="10")
        container.pack(fill=tk.BOTH, expand=True)

        # Exchange Section
        ttk.Label(container, text="Exchange", font=('Helvetica', 12, 'bold')).pack(pady=(0, 5))
        exchange_values = ["okx", "binance"]
        exchange_dropdown = ttk.Combobox(
            container, 
            textvariable=self.variables["exchange_var"],
            values=exchange_values,
            state="readonly"
        )
        exchange_dropdown.pack(pady=(0, 15))

        # Trade Type Section
        ttk.Label(container, text="Trade Type", font=('Helvetica', 12, 'bold')).pack(pady=(0, 5))
        type_values = ["spot", "perps", "invperps"]
        type_dropdown = ttk.Combobox(
            container, 
            textvariable=self.variables["type_var"],
            values=type_values,
            state="readonly"
        )
        type_dropdown.pack(pady=(0, 15))
        type_dropdown.bind('<<ComboboxSelected>>', self.on_type_change)

        # Symbol Section
        ttk.Label(container, text="Trading Pair", font=('Helvetica', 12, 'bold')).pack(pady=(0, 5))
        symbol_dropdown = ttk.Combobox(
            container,
            textvariable=self.variables["symbol_var"],
            state="readonly"
        )
        symbol_dropdown.pack(pady=(0, 15))

        # Order Details Frame
        order_frame = ttk.LabelFrame(container, text="Order Details", padding="10")
        order_frame.pack(fill=tk.X, pady=(0, 15))

        # Side Selection
        ttk.Label(order_frame, text="Side:").pack()
        self.side_dropdown = ttk.Combobox(
            order_frame,
            textvariable=self.variables["side_var"],
            values=["buy", "sell"],
            state="readonly"
        )
        self.side_dropdown.pack(pady=(0, 10))

        # Quantity with presets
        ttk.Label(order_frame, text="Quantity:").pack()
        qty_frame = ttk.Frame(order_frame)
        qty_frame.pack(pady=(0, 10))
        
        self.qty_entry = ttk.Entry(qty_frame, textvariable=self.variables["qty_var"], width=15)
        self.qty_entry.pack(side=tk.LEFT)
        qty_dropdown = ttk.Combobox(
            qty_frame,
            values=self.qty_presets,
            width=10,
            state="readonly"
        )
        qty_dropdown.pack(side=tk.LEFT, padx=(5, 0))
        qty_dropdown.bind('<<ComboboxSelected>>', 
                         lambda e: self.variables["qty_var"].set(qty_dropdown.get()))

        # Margin Settings Frame
        margin_frame = ttk.LabelFrame(container, text="Margin Settings", padding="10")
        margin_frame.pack(fill=tk.X, pady=(0, 15))

        # Margin Mode
        ttk.Label(margin_frame, text="Margin Mode:").pack()
        margin_mode_values = ["cross", "isolated"]
        self.margin_mode_dropdown = ttk.Combobox(
            margin_frame,
            textvariable=self.variables["margin_mode_var"],
            values=margin_mode_values,
            state="readonly"
        )
        self.margin_mode_dropdown.pack(pady=(0, 10))

        # Leverage
        ttk.Label(margin_frame, text="Leverage:").pack()
        leverage_values = ["1", "2", "3", "5", "10", "20", "50", "75", "100", "125"]
        self.leverage_dropdown = ttk.Combobox(
            margin_frame,
            textvariable=self.variables["leverage_var"],
            values=leverage_values,
            state="readonly"
        )
        self.leverage_dropdown.pack(pady=(0, 10))

        # Close Position Frame
        close_frame = ttk.LabelFrame(container, text="Position Management", padding="10")
        close_frame.pack(fill=tk.X, pady=(0, 15))
        
        ttk.Checkbutton(
            close_frame,
            text="Close Position",
            variable=self.variables["close_position_var"],
            command=self.on_close_position_toggle
        ).pack()

        # Action Buttons
        button_frame = ttk.Frame(container)
        button_frame.pack(fill=tk.X, pady=(0, 10))
        
        ttk.Button(
            button_frame,
            text="Send Webhook",
            command=self.send_webhook,
            style='Accent.TButton'
        ).pack(side=tk.LEFT, expand=True, padx=5)
        
        ttk.Button(
            button_frame,
            text="Clear Form",
            command=self.clear_form
        ).pack(side=tk.LEFT, expand=True, padx=5)

    def on_type_change(self, event=None):
        trade_type = self.variables["type_var"].get()
        
        # Update symbol dropdown
        symbol_pairs = self.trading_pairs.get(trade_type, [])
        symbol_dropdown = self.nametowidget(self.winfo_children()[0].winfo_children()[5])
        symbol_dropdown['values'] = symbol_pairs
        if symbol_pairs:
            symbol_dropdown.set(symbol_pairs[0])

        # Update margin settings based on type
        if trade_type == "spot":
            self.variables["margin_mode_var"].set("cash")
            self.variables["leverage_var"].set("1")
            self.margin_mode_dropdown.configure(state="disabled")
            self.leverage_dropdown.configure(state="disabled")
        else:
            self.margin_mode_dropdown.configure(state="readonly")
            self.leverage_dropdown.configure(state="readonly")
            self.variables["margin_mode_var"].set("cross")
            self.variables["leverage_var"].set("10")

    def on_close_position_toggle(self):
        is_closing = self.variables["close_position_var"].get()
        state = "disabled" if is_closing else "readonly"
        
        # Use stored widget references
        if self.side_dropdown:
            self.side_dropdown.configure(state=state)
        if self.qty_entry:
            self.qty_entry.configure(state="disabled" if is_closing else "normal")

    def clear_form(self):
        for var in self.variables.values():
            if isinstance(var, tk.BooleanVar):
                var.set(False)
            else:
                var.set('')
        self.on_type_change()

    def validate_input(self) -> tuple[bool, str]:
        if not self.variables["exchange_var"].get():
            return False, "Please select an exchange"
        if not self.variables["type_var"].get():
            return False, "Please select a trade type"
        if not self.variables["symbol_var"].get():
            return False, "Please select a trading pair"
        
        is_closing = self.variables["close_position_var"].get()
        if not is_closing:
            if not self.variables["side_var"].get():
                return False, "Please select a side"
            if not self.variables["qty_var"].get():
                return False, "Please enter a quantity"
            
            # Validate quantity format
            qty = self.variables["qty_var"].get()
            if qty.endswith('%'):
                try:
                    pct = float(qty[:-1])
                    if not 0 < pct <= 100:
                        return False, "Percentage must be between 0 and 100"
                except ValueError:
                    return False, "Invalid percentage format"
            else:
                try:
                    amt = float(qty)
                    if amt <= 0:
                        return False, "Quantity must be greater than 0"
                except ValueError:
                    return False, "Invalid quantity format"
                    
        return True, ""

    def send_webhook(self):
        valid, error_msg = self.validate_input()
        if not valid:
            messagebox.showerror("Validation Error", error_msg)
            return

        # Construct payload
        payload: Dict[str, Any] = {
            "authToken": AUTH_TOKEN,
            "exchange": self.variables["exchange_var"].get(),
            "symbol": self.variables["symbol_var"].get(),
            "type": self.variables["type_var"].get(),
            "marginMode": self.variables["margin_mode_var"].get()
        }

        # Add leverage for non-spot trades
        if payload["type"] != "spot":
            payload["leverage"] = int(self.variables["leverage_var"].get())

        # Add fields for new positions
        if not self.variables["close_position_var"].get():
            payload.update({
                "side": self.variables["side_var"].get(),
                "qty": self.variables["qty_var"].get()
            })
        else:
            payload["closePosition"] = True

        try:
            # Log the request
            logging.info(f"Sending webhook: {json.dumps(payload, indent=2)}")
            
            # Send request
            response = requests.post(
                WEBHOOK_URL,
                json=payload,
                headers={"Content-Type": "application/json"}
            )
            
            # Log the response
            logging.info(f"Response status: {response.status_code}")
            logging.info(f"Response body: {response.text}")
            
            if response.ok:
                messagebox.showinfo("Success", "Order sent successfully!")
            else:
                messagebox.showerror("Error", f"Failed to send order: {response.text}")
                
        except Exception as e:
            logging.error(f"Error sending webhook: {str(e)}")
            messagebox.showerror("Error", f"Failed to send webhook: {str(e)}")

if __name__ == "__main__":
    app = WebhookApp()
    app.mainloop()
